"""All SQL of the email stage: its queue (`uncontacted_leads`) and the lead's one `cold_emails` row.

`cold_emails.status` is what the queue reads: draft / sending / sent / rejected / generation_failed all keep
the lead out of it, only send_failed is offered again. Every write here replaces the row the lead already
has, so a lead keeps exactly one row across every attempt.
"""

from __future__ import annotations

import logging

from core.db import Db, Tx
from core.log import slog
from core.sqlite import insert_sql, set_clause, utc_now
from stages.email.models import EmailPlan, UncontactedLead
from stages.email.writer import MAX_CONTEXT_CHARS

QUEUE_LIMIT = 50            # leads per queue load (reloaded once worked through: each is a few AI calls)


async def uncontacted_leads(db: Db) -> list[UncontactedLead]:
    """Leads that have not been emailed yet (the email pool's queue): qualified, with an email address and
    at least one page read, and no `cold_emails` row (except `send_failed` ones, which come back).

    Each row carries `id` (= website id), `name`, `category`, `location`, `email`, `industry`,
    `employee_size`, the scrape's `summary`, the task's `target_role` / `opportunity_type`, and
    `content_json`, a JSON array of the lead's scraped internal pages. Each page's text is cut here to what
    the writer can use (it reads at most MAX_CONTEXT_CHARS of all the pages together), so a load doesn't
    carry every page in full.
    """
    rows = await db.fetch_all(
        """SELECT w.id, w.name, w.category, w.location, w.email,
                  (SELECT json_group_array(json_object(
                              'page_name', p.page_name, 'page_url', p.page_url,
                              'content_json', CASE WHEN json_type(p.content_json, '$.content') = 'text'
                                  THEN json_set(p.content_json, '$.content',
                                                substr(json_extract(p.content_json, '$.content'), 1, :chars))
                                  ELSE json(p.content_json) END))
                   FROM website_pages p WHERE p.scrape_id = s.id) AS content_json,
                  w.industry, w.employee_size, s.summary, w.target_role, w.opportunity_type
           FROM websites w
           JOIN website_scrapes s ON s.website_id = w.id AND s.is_qualified = 1
           WHERE w.email IS NOT NULL AND w.email <> ''
             AND EXISTS (SELECT 1 FROM website_pages p WHERE p.scrape_id = s.id AND p.content_json IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM cold_emails c WHERE c.website_id = w.id AND c.status <> 'send_failed')
           ORDER BY w.created_at LIMIT :limit""", {"chars": MAX_CONTEXT_CHARS, "limit": QUEUE_LIMIT},
        what="uncontacted leads")
    return [UncontactedLead.from_row(r) for r in rows]


STATUS_DRAFT = "draft"                         # dry-run mode: written, never sent; the dashboard shows it for review
STATUS_GENERATION_FAILED = "generation_failed"   # no approved draft: the lead has a row, so the queue stops returning it


def _replace_email_row(tx: Tx, row: dict) -> str:
    """Delete any `cold_emails` row the lead already has, insert `row`, return its id. A lead keeps exactly
    one row across every attempt instead of accumulating one per retry."""
    tx.execute("DELETE FROM cold_emails WHERE website_id = ?", (row["website_id"],))
    return tx.fetch_one(*insert_sql("cold_emails", row, returning="id"))["id"]


async def create_sending(db: Db, plan: EmailPlan, delivery: str) -> str:
    """Insert the `cold_emails` row BEFORE sending, so a crash between send and DB write can never leave a
    lead looking uncontacted (and get emailed twice). Replaces any row this lead already has (a stale
    `send_failed` row on a retry). `delivery` is the channel it goes through (EMAIL.delivery). Returns the
    new row's id."""
    row = {
        "website_id": plan.website_id,
        "email_address": plan.to_email,
        "subject": plan.subject,
        "body": plan.body,
        "attachment_name": plan.attachment_name,
        "delivery": delivery,
        "status": "sending",
    }
    return await db.transaction(lambda tx: _replace_email_row(tx, row), what="insert cold_emails")


async def save_draft(db: Db, plan: EmailPlan) -> None:
    """Dry-run mode: keep the written email as a `draft` row for the dashboard, instead of sending it. Like
    `create_sending`, replaces any row the lead already has. The queue stops returning a lead with a row, so
    each lead is drafted once; `clear_drafts` hands them back when the pool goes live."""
    row = {"website_id": plan.website_id, "email_address": plan.to_email, "subject": plan.subject,
           "body": plan.body, "attachment_name": plan.attachment_name, "status": STATUS_DRAFT}
    await db.transaction(lambda tx: _replace_email_row(tx, row), what="insert cold_emails (draft)")


async def clear_drafts(db: Db) -> None:
    """Send mode: delete the dry-run drafts, so their leads are uncontacted again and get a real email."""
    await db.execute("DELETE FROM cold_emails WHERE status = ?", (STATUS_DRAFT,), what="clear cold_emails drafts")


async def mark_email(db: Db, record_id: str, status: str) -> None:
    """Record the outcome of a send: "sent", "send_failed" or "rejected"."""
    update = {"status": status}
    if status == "sent":
        update["sent_at"] = utc_now()
    assignments, params = set_clause(update)
    await db.execute(f"UPDATE cold_emails SET {assignments} WHERE id = :id", {**params, "id": record_id},
                     what="mark cold_emails")


async def record_generation_failure(db: Db, website_id: str, to_email: str) -> None:
    """No approved draft could be written: replace any row this lead already has (a stale `send_failed`
    from an earlier attempt) with a `generation_failed` row (no subject / body) so the queue stops returning
    the lead, and the lead keeps exactly one `cold_emails` row. Never raises."""
    row = {"website_id": website_id, "email_address": to_email, "status": STATUS_GENERATION_FAILED}
    try:
        await db.transaction(lambda tx: _replace_email_row(tx, row), what="insert cold_emails (generation_failed)")
    except Exception as exc:  # noqa: BLE001 — bookkeeping must not break the pool
        slog(f"could not record the generation failure for website {website_id}: {exc}", level=logging.ERROR)
