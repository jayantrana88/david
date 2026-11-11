"""Each pool's "pending work" query, against a fresh SQLite file seeded with leads in every state."""

import asyncio

import pytest

from core.db import Db
from stages.email import store as email_store
from stages.internal import store as internal_store
from stages.scrape import store as scrape_store

# website id -> (is_qualified or "none" for no scrape row, pages, email, cold_emails status or None)
LEADS = {
    "new":         ("none", None, None, None),           # no scrape yet                 -> scrape
    "undecided":   (None, None, None, None),             # the AI hasn't answered        -> scrape
    "unqualified": (False, None, None, None),            #                                -> nowhere
    "no_pages":    (True, None, None, None),             # qualified, pages not read yet -> internal
    "placeholder": (True, "placeholder", None, None),    # every page read failed         -> internal
    "no_email":    (True, "pages", None, None),          #                                -> nowhere
    "ready":       (True, "pages", "hi@ready.com", None),            #                    -> email
    "send_failed": (True, "pages", "hi@sf.com", "send_failed"),      # re-offered         -> email
    "sent":        (True, "pages", "hi@sent.com", "sent"),           #                    -> nowhere
    "draft":       (True, "pages", "hi@draft.com", "draft"),         #                    -> nowhere
}


# The queues as website ids (the only part to adapt when the loaders change)

async def scrape_queue(db: Db) -> set[str]:
    return {job.id for job in await scrape_store.pending_websites(db)}


async def internal_queue(db: Db) -> set[str]:
    return {s.website_id for s in await internal_store.pending_scrapes(db)}


async def email_queue(db: Db) -> set[str]:
    return {lead.id for lead in await email_store.uncontacted_leads(db)}


async def seed(db: Db) -> None:
    for i, (wid, (qualified, pages, email, sent)) in enumerate(LEADS.items()):
        created = f"2026-01-01T00:00:{i:02d}.000Z"
        await db.execute("INSERT INTO websites (id, name, website_url, email, created_at) VALUES (?, ?, ?, ?, ?)",
                         (wid, wid, f"https://{wid}.example", email, created))
        if qualified == "none":
            continue
        await db.execute("INSERT INTO website_scrapes (id, website_id, is_qualified, main_links, created_at) "
                         "VALUES (?, ?, ?, ?, ?)", (f"s_{wid}", wid, qualified, {"About": "https://x/about"}, created))
        if pages == "placeholder":
            await db.execute("INSERT INTO website_pages (scrape_id, page_name) VALUES (?, 'Internal pages')",
                             (f"s_{wid}",))
        elif pages == "pages":
            await db.execute("INSERT INTO website_pages (scrape_id, page_name, page_url, content_json) "
                             "VALUES (?, 'About', 'https://x/about', ?)", (f"s_{wid}", {"content": "We build."}))
        if sent:
            await db.execute("INSERT INTO cold_emails (website_id, email_address, status) VALUES (?, ?, ?)",
                             (wid, email, sent))


@pytest.fixture
def queues(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PATH", str(tmp_path / "queues.db"))

    async def collect():
        db = await Db.connect()
        try:
            await seed(db)
            return await scrape_queue(db), await internal_queue(db), await email_queue(db)
        finally:
            await db.aclose()

    return asyncio.run(collect())


def test_scrape_queue(queues):
    assert queues[0] == {"new", "undecided"}


def test_internal_queue(queues):
    assert queues[1] == {"no_pages", "placeholder"}


def test_email_queue(queues):
    assert queues[2] == {"ready", "send_failed"}


def test_email_queue_cuts_pages_without_changing_what_the_writer_reads(tmp_path, monkeypatch):
    """The queue cuts each page's text in SQL; the writer's research text must be what the full pages gave."""
    import json

    from stages.email.writer import MAX_CONTEXT_CHARS, _research_text

    monkeypatch.setenv("DB_PATH", str(tmp_path / "pages.db"))
    pages = [{"title": "About", "description": "Who we are", "content": "line\n" * 3000},
             {"content": "Homepage summary only"}]

    async def research():
        db = await Db.connect()
        try:
            await db.execute("INSERT INTO websites (id, name, website_url, email) VALUES ('w', 'W', 'https://w', 'a@w.com')")
            await db.execute("INSERT INTO website_scrapes (id, website_id, is_qualified) VALUES ('s', 'w', 1)")
            for i, page in enumerate(pages):
                await db.execute("INSERT INTO website_pages (scrape_id, page_name, page_url, content_json, created_at) "
                                 "VALUES ('s', ?, ?, ?, ?)", (f"p{i}", f"https://w/{i}", page, f"2026-01-0{i + 1}"))
            [lead] = await email_store.uncontacted_leads(db)
            return lead
        finally:
            await db.aclose()

    lead = asyncio.run(research())
    full = [{"page_name": f"p{i}", "page_url": f"https://w/{i}", "content_json": page} for i, page in enumerate(pages)]
    assert _research_text(lead) == json.dumps(full, ensure_ascii=False)[:MAX_CONTEXT_CHARS]
    assert len(lead.content_json[0]["content_json"]["content"]) == MAX_CONTEXT_CHARS


def test_daily_tasks_come_back_after_24_hours(tmp_path, monkeypatch):
    """A `repeat_daily` task that finished 24 h ago or more is queued again (leads_saved reset); others stay."""
    from stages.sourcing import store as sourcing_store

    monkeypatch.setenv("DB_PATH", str(tmp_path / "tasks.db"))
    old, recent = "2020-01-01T00:00:00.000Z", "2999-01-01T00:00:00.000Z"
    rows = [  # (category, repeat_daily, status, finished_at)
        ("due", 1, "completed", old),
        ("due_failed", 1, "failed", old),
        ("too_soon", 1, "completed", recent),
        ("no_repeat", 0, "completed", old),
        ("busy", 1, "running", old),
    ]

    async def run():
        db = await Db.connect()
        try:
            for category, repeat, status, finished in rows:
                await db.execute("INSERT INTO tasks (category, location, repeat_daily, status, finished_at, leads_saved, error) "
                                 "VALUES (?, 'Paris', ?, ?, ?, 7, 'x')", (category, repeat, status, finished))
            queue = await sourcing_store.next_pending_task(db)
            states = {r["category"]: (r["status"], r["leads_saved"], r["error"]) for r in
                      await db.fetch_all("SELECT category, status, leads_saved, error FROM tasks")}
            return queue, states
        finally:
            await db.aclose()

    queue, states = asyncio.run(run())
    assert queue[0].category == "due"
    assert states["due"] == ("pending", 0, None) and states["due_failed"] == ("pending", 0, None)
    assert states["too_soon"][0] == "completed" and states["no_repeat"][0] == "completed"
    assert states["busy"][0] == "running"
