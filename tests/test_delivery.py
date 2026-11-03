"""The delivery channels (apis/telegram, gmail, outlook) against fake transports, and the email worker's
send path (sent / rejected / uncertain) against a temporary database. No network."""

import asyncio
import json

import httpx
import pytest

import core.limits
from apis import mail
from apis.gmail import GmailClient
from apis.mail import REJECTED, SEND_FAILED, SENT, UNCERTAIN, Attachment, build_message, save_token
from apis.outlook import OutlookClient
from apis.telegram import MAX_COPY_TEXT, TelegramClient, chunk_text, copy_keyboard, format_message
from core.db import Db
from core.http import HttpClient
from core.limits import RateLimiter

BODY = ("Hi Acme team,\n\nI am applying for the data analyst internship at Acme <Labs> & Co. "
        + "I have built dashboards in Python and SQL for two student projects. " * 6
        + "\n\nMy resume is attached.\n\nBest regards,\nJane Doe\nhttps://janedoe.dev")
CV = Attachment("Jane_Doe_CV.pdf", b"%PDF-1.4 fake")


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def fast_limits(monkeypatch, tmp_path):
    """No rate pacing, and token files / the database in a temporary folder."""
    monkeypatch.setenv("DB_PATH", str(tmp_path / "delivery.db"))
    for api in ("telegram", "gmail", "outlook"):
        monkeypatch.setitem(core.limits._limiters, api, RateLimiter(concurrency=1, rpm=600_000))


def fake_http(handler) -> HttpClient:
    http = HttpClient()
    http._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return http


# ── Telegram ──────────────────────────────────────────────────────────────────

def test_copy_pieces_fit_telegram_and_paste_back_into_the_body():
    pieces = chunk_text(BODY, MAX_COPY_TEXT)
    assert len(pieces) > 1 and all(0 < len(p) <= MAX_COPY_TEXT for p in pieces)
    assert "".join(pieces) == BODY
    assert chunk_text("x" * 600, 256) == ["x" * 256, "x" * 256, "x" * 88]   # no break anywhere: hard cuts


def test_keyboard_copies_address_subject_and_body():
    rows = copy_keyboard("hi@acme.com", "Data analyst internship", BODY)["inline_keyboard"]
    buttons = [b for row in rows for b in row]
    assert all(len(row) <= 2 for row in rows)
    assert buttons[0] == {"text": "📋 To", "copy_text": {"text": "hi@acme.com"}}
    assert buttons[1]["copy_text"]["text"] == "Data analyst internship"
    assert buttons[2]["text"].startswith("📋 Body 1/")
    assert "".join(b["copy_text"]["text"] for b in buttons[2:]) == BODY


def test_message_is_escaped_html_and_too_long_falls_back():
    text = format_message("hi@acme.com", "A <b> & c", BODY, [CV])
    assert "<code>A &lt;b&gt; &amp; c</code>" in text and "Jane_Doe_CV.pdf" in text
    assert "<pre>" in text and "Acme &lt;Labs&gt; &amp; Co." in text
    assert format_message("hi@acme.com", "S", "x" * 5000, None) is None


def test_telegram_posts_one_formatted_message_with_buttons():
    posted = []

    def handler(request):
        posted.append(json.loads(request.content))
        return httpx.Response(200, json={"ok": True, "result": {"message_id": len(posted)}})

    client = TelegramClient(fake_http(handler), bot_token="t", chat_id="42")
    assert run(client.send("hi@acme.com", "Subject", BODY, [CV])) == (SENT, "1")
    assert len(posted) == 1 and posted[0]["parse_mode"] == "HTML" and posted[0]["chat_id"] == "42"
    assert posted[0]["reply_markup"]["inline_keyboard"]

    posted.clear()          # too long for one message: plain parts, the buttons under the last
    assert run(client.send("hi@acme.com", "Subject", "line\n" * 1500))[0] == SENT
    assert len(posted) == 2 and "parse_mode" not in posted[0]
    assert "reply_markup" not in posted[0] and "reply_markup" in posted[1]


# ── MIME ──────────────────────────────────────────────────────────────────────

def test_mime_message_has_sender_name_and_the_resume():
    msg = build_message("hi@acme.com", "Subject", "Body", [CV], from_addr="jane@gmail.com", from_name="Jane Doe")
    assert msg["From"] == "Jane Doe <jane@gmail.com>" and msg["To"] == "hi@acme.com"
    [part] = list(msg.iter_attachments())
    assert part.get_filename() == "Jane_Doe_CV.pdf" and part.get_content_type() == "application/pdf"
    assert part.get_content() == CV.content
    assert "From" not in build_message("hi@acme.com", "S", "B")     # Gmail's API fills it in


# ── Gmail / Outlook (OAuth) ───────────────────────────────────────────────────

class Provider:
    """A fake token endpoint + send endpoint. `answers` are the send endpoint's replies, in order (an
    exception is raised instead of answering)."""

    def __init__(self, answers, refresh_token="rt-1"):
        self.answers = list(answers)
        self.sends: list[httpx.Request] = []
        self.refreshes: list[dict] = []
        self.refresh_token = refresh_token

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if "token" in request.url.path:
            self.refreshes.append(dict(httpx.QueryParams(request.content.decode())))
            return httpx.Response(200, json={"access_token": f"at-{len(self.refreshes)}", "expires_in": 3600,
                                             "refresh_token": self.refresh_token})
        self.sends.append(request)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


def gmail_with(provider) -> GmailClient:
    save_token("gmail", {"refresh_token": "rt-1", "email": "jane@gmail.com"})
    return GmailClient(fake_http(provider), client_id="cid", client_secret="secret")


def test_gmail_not_connected_is_a_clear_error():
    with pytest.raises(RuntimeError, match="mail_setup.py connect gmail"):
        GmailClient(fake_http(lambda r: httpx.Response(500)), client_id="cid", client_secret="secret")


def test_gmail_sends_raw_mime_and_refreshes_an_expired_token():
    provider = Provider([httpx.Response(401), httpx.Response(200, json={"id": "msg-1"})])
    status, detail = run(gmail_with(provider).send("hi@acme.com", "Subject", "Body", [CV], from_name="Jane Doe"))
    assert (status, detail) == (SENT, "msg-1")
    assert len(provider.refreshes) == 2         # the 401 threw the first access token away
    last = provider.sends[-1]
    assert last.headers["Authorization"] == "Bearer at-2" and last.headers["Content-Type"] == "message/rfc822"
    assert b"From: Jane Doe <jane@gmail.com>" in last.content and b"Jane_Doe_CV.pdf" in last.content


@pytest.mark.parametrize("answer, expected", [
    (httpx.Response(400, text='{"error": {"message": "Invalid To header"}}'), REJECTED),
    (httpx.Response(403, text="insufficient permissions"), SEND_FAILED),
    (httpx.ReadTimeout("no answer"), UNCERTAIN),        # it may have been sent: never retried
])
def test_gmail_outcomes(answer, expected):
    provider = Provider([answer])
    assert run(gmail_with(provider).send("hi@acme.com", "S", "B"))[0] == expected
    assert len(provider.sends) == 1


def test_gmail_revoked_sign_in_is_a_send_failure():
    save_token("gmail", {"refresh_token": "revoked"})
    client = GmailClient(fake_http(lambda r: httpx.Response(400, json={"error": "invalid_grant"})),
                         client_id="cid", client_secret="secret")
    status, detail = run(client.send("hi@acme.com", "S", "B"))
    assert status == SEND_FAILED and "connect gmail" in detail


def test_outlook_sends_json_and_keeps_the_rotated_refresh_token():
    save_token("outlook", {"refresh_token": "rt-1", "email": "jane@outlook.com"})
    provider = Provider([httpx.Response(202, headers={"request-id": "req-9"})], refresh_token="rt-2")
    client = OutlookClient(fake_http(provider), client_id="cid", client_secret="")
    assert run(client.send("hi@acme.com", "Subject", "Body", [CV])) == (SENT, "req-9")
    assert "client_secret" not in provider.refreshes[0] and provider.refreshes[0]["refresh_token"] == "rt-1"
    payload = json.loads(provider.sends[0].content)
    assert payload["message"]["toRecipients"] == [{"emailAddress": {"address": "hi@acme.com"}}]
    assert payload["message"]["attachments"][0]["name"] == "Jane_Doe_CV.pdf"
    assert mail.load_token("outlook")["refresh_token"] == "rt-2"


# ── the email worker's send path ──────────────────────────────────────────────

class FakeMailer:
    def __init__(self, answers):
        self.answers = answers      # to_email -> (status, detail)
        self.calls = []

    async def send(self, to_email, subject, text, attachments=None, *, from_name=""):
        self.calls.append((to_email, from_name))
        return self.answers[to_email]


def test_worker_records_each_outcome(monkeypatch):
    from config import EMAIL
    from core.errors import LeadFailed
    from stages.email import worker as email_worker
    from stages.email.models import EmailPlan

    mailer = FakeMailer({"ok@a.com": (SENT, "1"), "bad@b.com": (REJECTED, "550"),
                         "lost@c.com": (UNCERTAIN, "timeout"), "down@d.com": (SEND_FAILED, "503")})
    monkeypatch.setattr(email_worker, "EMAIL", EMAIL.updated(mode="send", delivery="gmail", attach_resume=False))
    monkeypatch.setattr(email_worker, "get_llm", lambda role: None)
    monkeypatch.setattr(email_worker, "get_mailer", lambda delivery: mailer)

    async def write(leads, profile, attachment_name=None):
        return [EmailPlan(lead.id, lead.email, "Subject", "Body") for lead in leads]
    monkeypatch.setattr(email_worker, "write_emails", write)

    async def go():
        db = await Db.connect()
        try:
            await db.execute("INSERT INTO candidate_profile (id, full_name, headline, parse_status) "
                             "VALUES (1, 'Jane Doe', 'Analyst', 'done')")
            for wid, addr in [("a", "ok@a.com"), ("b", "bad@b.com"), ("c", "lost@c.com"), ("d", "down@d.com")]:
                await db.execute("INSERT INTO websites (id, name, website_url, email) VALUES (?, ?, ?, ?)",
                                 (wid, wid, f"https://{wid}.example", addr))
                await db.execute("INSERT INTO website_scrapes (id, website_id, is_qualified) VALUES (?, ?, 1)",
                                 (f"s_{wid}", wid))
                await db.execute("INSERT INTO website_pages (scrape_id, page_name, content_json) VALUES (?, 'About', ?)",
                                 (f"s_{wid}", {"content": "We build."}))
            worker = email_worker.make_worker(db)
            leads = await worker._load(db)
            outcomes = await worker._run_batch(db, leads)
            rows = await db.fetch_all("SELECT website_id, status, delivery FROM cold_emails ORDER BY website_id")
            return outcomes, rows, await worker._load(db)
        finally:
            await db.aclose()

    outcomes, rows, requeued = run(go())
    assert [(r["website_id"], r["status"], r["delivery"]) for r in rows] == [
        ("a", "sent", "gmail"), ("b", "rejected", "gmail"), ("c", "sending", "gmail"), ("d", "send_failed", "gmail")]
    assert outcomes[0] is None
    assert isinstance(outcomes[1], LeadFailed) and outcomes[1].permanent
    assert isinstance(outcomes[2], LeadFailed) and outcomes[2].permanent       # maybe sent: never again
    assert isinstance(outcomes[3], LeadFailed) and not outcomes[3].permanent
    assert [lead.id for lead in requeued] == ["d"]                              # only send_failed comes back
    assert {name for _, name in mailer.calls} == {"Jane Doe"}
