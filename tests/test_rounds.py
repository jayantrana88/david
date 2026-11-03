"""A round of the scrape and email pools against a fake AI and a fake Jina: batching, re-asking alone, and
how each failure becomes a result."""

import asyncio
import json
import re

import pytest

import config
from core.errors import LeadFailed, LeadSkipped
from core.llm import LLMAuthError, ask_in_batches
from stages.email.models import EmailPlan, UncontactedLead
from stages.email.run import NoApprovedDraft, write_emails
from stages.profile.models import CandidateProfile
from stages.scrape.models import ScrapeJob
from stages.scrape.run import run_site_scrape

PROFILE = CandidateProfile(full_name="Asha Rao", target_roles=["Data Analyst"], parse_status="done")
GOOD_BODY = " ".join(["word"] * 40) + "\n\n" + " ".join(["more"] * 40) + " My resume is attached."


class FakeLLM:
    """Answers by schema name; `reply(kind, prompt)` gives the text. Records every call."""

    def __init__(self, reply):
        self.reply, self.calls = reply, []

    async def chat(self, prompt, *, response_format=None, attempts=None):
        kind = response_format["json_schema"]["name"]
        self.calls.append((kind, attempts))
        return self.reply(kind, prompt)


def numbers_in(prompt: str) -> list[int]:
    return [int(n) for n in re.findall(r"\[(\d+)\]", prompt)]


# ── ask_in_batches ────────────────────────────────────────────────────────────

def run(coro):
    return asyncio.run(coro)


def test_chunks_and_asks_the_unanswered_alone():
    calls = []

    async def ask_batch(chunk):
        calls.append(("batch", list(chunk)))
        return {i + 1: f"b{x}" for i, x in enumerate(chunk) if x != 2}     # leaves item 2 out

    async def ask_one(x, attempts):
        calls.append(("one", x, attempts))
        return f"a{x}"

    out = run(ask_in_batches([1, 2, 3, 4, 5], size=2, ask_batch=ask_batch, ask_one=ask_one, what="t"))
    assert out == ["b1", "a2", "b3", "b4", "a5"]          # 5 is a chunk of one: asked alone
    assert ("one", 2, None) in calls and ("one", 5, None) in calls


def test_failed_batch_call_asks_each_once_and_unavailable_is_everyones_answer():
    async def failing(chunk):
        raise RuntimeError("500")

    async def ask_one(x, attempts):
        return attempts

    assert run(ask_in_batches([1, 2], size=5, ask_batch=failing, ask_one=ask_one, what="t")) == [1, 1]

    async def unavailable(chunk):
        raise LLMAuthError("bad key")

    out = run(ask_in_batches([1, 2], size=5, ask_batch=unavailable, ask_one=ask_one, what="t"))
    assert all(isinstance(o, LLMAuthError) for o in out)


# ── a scrape round ────────────────────────────────────────────────────────────

class FakeJina:
    async def read(self, url):
        if "down" in url:
            return None
        return {"code": 200, "data": {"title": url, "content": f"We build things at {url}", "usage": {"tokens": 5}}}


@pytest.fixture
def fakes(monkeypatch):
    def install(reply):
        llm = FakeLLM(reply)
        monkeypatch.setattr("stages.scrape.qualify.get_llm", lambda role: llm)
        monkeypatch.setattr("stages.scrape.run.get_jina", lambda: FakeJina())
        monkeypatch.setattr("stages.email.writer.get_llm", lambda role: llm)
        return llm
    return install


def test_scrape_round(fakes, monkeypatch):
    monkeypatch.setattr(config, "AI", config.AI.updated(qualify_batch=10))

    def reply(kind, prompt):
        assert kind == "qualification_batch"
        return json.dumps({"results": [{"number": n, "qualified": n == 1, "summary": f"s{n}"}
                                       for n in numbers_in(prompt)]})

    llm = fakes(reply)
    jobs = [ScrapeJob("a", website_url="https://a.example"),
            ScrapeJob("down", website_url="https://down.example"),
            ScrapeJob("saved", website_url="https://saved.example", scrape_id="s1")]
    results = run(run_site_scrape(jobs, PROFILE, {"saved": {"homepage_text": "Saved homepage text"}}))
    assert [r.is_qualified for r in results] == [True, False, False]
    assert results[0].summary == "s1" and results[0].tokens == 5 and results[2].scrape_id == "s1"
    assert results[2].text == "Saved homepage text" and results[2].tokens == "?"   # not fetched again
    assert llm.calls == [("qualification_batch", None)]     # two companies, one call


def test_scrape_round_unavailable(fakes):
    def reply(kind, prompt):
        raise LLMAuthError("bad key")

    fakes(reply)
    [result] = run(run_site_scrape([ScrapeJob("a", website_url="https://a.example")], PROFILE))
    assert result.is_qualified is None and isinstance(result.llm_error, LLMAuthError) and result.text


# ── an email round ────────────────────────────────────────────────────────────

def test_email_round(fakes, monkeypatch):
    monkeypatch.setattr(config, "AI", config.AI.updated(email_batch=3))

    def reply(kind, prompt):
        if kind == "cold_email_batch":      # lead 1 passes the rules, lead 2's draft is too short
            return json.dumps({"emails": [{"number": 1, "subject": "Data analyst internship", "body": GOOD_BODY},
                                          {"number": 2, "subject": "Data analyst internship", "body": "Too short."}]})
        if "Shorty" in prompt:              # the rewrite of lead 2 still fails
            return json.dumps({"subject": "Data analyst internship", "body": "Still short."})
        raise AssertionError("unexpected call")

    llm = fakes(reply)
    leads = [UncontactedLead("1", name="Acme", email="hi@acme.com"),
             UncontactedLead("2", name="Shorty", email="hi@shorty.com"),
             UncontactedLead("3", name="Nobody", email="noreply@nobody.com")]
    plans = run(write_emails(leads, PROFILE, "cv.pdf"))
    assert isinstance(plans[0], EmailPlan) and plans[0].body.startswith("Hi Acme team,")
    assert plans[0].attachment_name == "cv.pdf"
    assert isinstance(plans[1], NoApprovedDraft) and plans[1].to_email == "hi@shorty.com"
    assert isinstance(plans[2], LeadSkipped)
    assert [k for k, _ in llm.calls] == ["cold_email_batch", "cold_email", "cold_email"]   # 2 rewrites alone


def test_email_ai_error_is_a_retryable_failure(fakes):
    def reply(kind, prompt):
        raise RuntimeError("boom")

    fakes(reply)
    [plan] = run(write_emails([UncontactedLead("1", name="Acme", email="hi@acme.com")], PROFILE))
    assert isinstance(plan, LeadFailed) and not plan.permanent
