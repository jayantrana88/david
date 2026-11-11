"""Async Telegram Bot API client: delivers each written application to one chat instead of emailing it.

Used by the email pool in "send" mode with EMAIL.delivery="telegram". Nothing is sent to the company: the
message carries the recipient, the subject and the body, so the candidate can send it from their own mail
client. To make that quick, the message has copy buttons (Bot API `copy_text`: a tap puts the text on the
clipboard): one for the address, one for the subject, and the body in pieces of at most 256 characters
(Telegram's limit per button). The body is also a code block, which Telegram copies whole in one tap.

    status, detail = await get_telegram().send("jane@acme.com", "Subject", "Body", [Attachment("cv.pdf", data)])
"""

from __future__ import annotations

import asyncio
import html
import logging
import re

import httpx

from apis.mail import SEND_FAILED, SENT, Attachment, Status
from config import credentials
from core.http import HttpClient
from core.limits import limit
from core.log import slog
from core.retry import is_connect_failure

__all__ = ["Attachment", "TelegramClient"]

API_URL = "https://api.telegram.org/bot{token}/sendMessage"
MAX_MESSAGE = 4096      # Telegram's limit on one message's text
MAX_COPY_TEXT = 256     # Telegram's limit on a copy_text button's text
BUTTONS_PER_ROW = 2

# Retried only when the message cannot have been delivered: Telegram answered 429 / 5xx, or the connection
# was never established. A timeout while waiting for the answer is NOT retried (it may have gone through).
RETRYABLE_STATUSES = frozenset({429, 500, 502, 503, 504})


class TelegramClient:
    """Thin wrapper around Telegram's sendMessage, on the shared HTTP pool."""

    def __init__(self, http: HttpClient, bot_token: str = credentials.telegram_bot_token,
                 chat_id: str = credentials.telegram_chat_id, *, attempts: int = 3) -> None:
        missing = [name for name, value in {"TELEGRAM_BOT_TOKEN": bot_token, "TELEGRAM_CHAT_ID": chat_id}.items()
                   if not value]
        if missing:
            raise RuntimeError(f"TelegramClient: missing on the dashboard's Settings page: {', '.join(missing)}")
        self.bot_token = bot_token
        self.chat_id = chat_id
        self._http = http
        self.attempts = attempts

    async def send(self, to_email: str, subject: str, text: str, attachments: list[Attachment] | None = None,
                   *, from_name: str = "") -> tuple[Status, str]:
        """Post the application to the chat, with its copy buttons. Returns (status, detail):

          "sent"        detail = Telegram message id (of the last part)
          "send_failed" network problem, 429 / 5xx, bad token or chat id: worth retrying
        """
        keyboard = copy_keyboard(to_email, subject, text)
        message = format_message(to_email, subject, text, attachments)
        if message is not None:
            return await self._post({"text": message, "parse_mode": "HTML", "reply_markup": keyboard})
        # Too long for one formatted message: plain text in parts, the buttons under the last one.
        header = f"To: {to_email}\nSubject: {subject}"
        if attachments:
            header += "\nAttach: " + ", ".join(a.filename for a in attachments)
        parts = split_text(f"{header}\n\n{text}")
        last_id = ""
        for i, part in enumerate(parts):
            fields = {"text": part}
            if i == len(parts) - 1:
                fields["reply_markup"] = keyboard
            status, detail = await self._post(fields)
            if status != SENT:
                return status, detail
            last_id = detail
        return SENT, last_id

    async def _post(self, fields: dict) -> tuple[Status, str]:
        resp: httpx.Response | None = None
        for attempt in range(1, self.attempts + 1):
            try:
                async with limit("telegram"):
                    resp = await self._http.post(API_URL.format(token=self.bot_token), timeout=30,
                                                 json={"chat_id": self.chat_id, "disable_web_page_preview": True,
                                                       **fields})
            except httpx.HTTPError as exc:
                if attempt < self.attempts and is_connect_failure(exc):
                    await self._wait(attempt, None, type(exc).__name__)
                    continue
                return SEND_FAILED, f"{type(exc).__name__}: {exc}"
            if resp.status_code in RETRYABLE_STATUSES and attempt < self.attempts:
                await self._wait(attempt, _retry_after(resp), f"HTTP {resp.status_code}")
                continue
            break

        assert resp is not None
        if resp.status_code == 200:
            return SENT, str(resp.json().get("result", {}).get("message_id", ""))
        return SEND_FAILED, f"HTTP {resp.status_code}: {resp.text[:300]}"

    @staticmethod
    async def _wait(attempt: int, retry_after: float | None, why: str) -> None:
        wait = max(2.0 * 2 ** (attempt - 1), retry_after or 0)
        slog(f"[telegram] {why}; retrying in {wait:.0f}s", level=logging.WARNING)
        await asyncio.sleep(wait)


def format_message(to_email: str, subject: str, text: str, attachments: list[Attachment] | None) -> str | None:
    """The application as one HTML message: address and subject in tap-to-copy code, the body as a code
    block. None when it would be over Telegram's limit (counted on the text Telegram shows, without tags)."""
    lines = ["📨 <b>Application ready to send</b>",
             f"<b>To:</b> <code>{html.escape(to_email)}</code>",
             f"<b>Subject:</b> <code>{html.escape(subject)}</code>"]
    shown = len(f"📨 Application ready to send\nTo: {to_email}\nSubject: {subject}\n\n{text}")
    if attachments:
        names = ", ".join(a.filename for a in attachments)
        lines.append(f"<b>Attach:</b> {html.escape(names)}")
        shown += len(f"\nAttach: {names}")
    if shown > MAX_MESSAGE - 16:     # Telegram counts UTF-16 units: an emoji is two
        return None
    return "\n".join(lines) + f"\n\n<pre>{html.escape(text)}</pre>"


def copy_keyboard(to_email: str, subject: str, text: str) -> dict:
    """The inline keyboard: copy the address, the subject, and the body piece by piece."""
    buttons = [_copy("📋 To", to_email), _copy("📋 Subject", subject)]
    pieces = chunk_text(text, MAX_COPY_TEXT)
    for i, piece in enumerate(pieces, 1):
        buttons.append(_copy(f"📋 Body {i}/{len(pieces)}" if len(pieces) > 1 else "📋 Body", piece))
    return {"inline_keyboard": [buttons[i:i + BUTTONS_PER_ROW] for i in range(0, len(buttons), BUTTONS_PER_ROW)]}


def _copy(label: str, text: str) -> dict:
    return {"text": label, "copy_text": {"text": text[:MAX_COPY_TEXT]}}


def chunk_text(text: str, size: int) -> list[str]:
    """`text` in pieces of at most `size` characters that paste back together into the original: cut after a
    paragraph break where possible, else after a line break, a sentence or a space."""
    pieces: list[str] = []
    while len(text) > size:
        window = text[:size]
        cut = 0
        for pattern in (r"\n\n", r"\n", r"[.!?] ", r" "):
            ends = [m.end() for m in re.finditer(pattern, window)]
            if ends and ends[-1] > size // 3:
                cut = ends[-1]
                break
        cut = cut or size
        pieces.append(text[:cut])
        text = text[cut:]
    if text:
        pieces.append(text)
    return pieces


def _retry_after(resp: httpx.Response) -> float | None:
    """Telegram puts the wait for a 429 in the JSON body: parameters.retry_after (seconds)."""
    try:
        return float(resp.json()["parameters"]["retry_after"])
    except (ValueError, KeyError, TypeError):
        return None


def split_text(text: str) -> list[str]:
    """Cut `text` into pieces of at most MAX_MESSAGE characters, at line breaks where possible."""
    parts: list[str] = []
    while len(text) > MAX_MESSAGE:
        cut = text.rfind("\n", 0, MAX_MESSAGE)
        cut = cut if cut > 0 else MAX_MESSAGE
        parts.append(text[:cut])
        text = text[cut:].lstrip("\n")
    parts.append(text)
    return parts
