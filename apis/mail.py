"""What every delivery channel shares (Telegram, Gmail, Outlook): the resume attachment, the outcome of
a send, the MIME message, and the OAuth access token kept fresh from a stored refresh token.

Each channel's client has the same `send`:

    status, detail = await mailer.send("jane@acme.com", "Subject", "Body", [Attachment("cv.pdf", data)],
                                       from_name="Jane Doe")

and returns one of these statuses (the email worker turns it into the `cold_emails` row):

    SENT         delivered; detail = the provider's message id (if it gives one)
    SEND_FAILED  certainly not delivered (network, 429 / 5xx, bad credentials): the lead is offered again
    REJECTED     the provider refused this recipient for good (bad address): the lead is not retried
    UNCERTAIN    the request went out but no answer came back: it may have been delivered, so the row stays
                 `sending` and the lead is not retried (a company must never get the same email twice)

The OAuth refresh tokens (Gmail, Outlook) are saved by `python mail_setup.py connect <provider>` in
data/mail_tokens/<provider>.json, next to the database (git-ignored with the rest of data/).
"""

from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import os
import time
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from pathlib import Path
from typing import Literal, Protocol

import httpx

from core import sqlite
from core.http import HttpClient
from core.limits import Api, limit
from core.log import slog
from core.retry import is_connect_failure

SENT, SEND_FAILED, REJECTED, UNCERTAIN = "sent", "send_failed", "rejected", "uncertain"
Status = Literal["sent", "send_failed", "rejected", "uncertain"]
OAuthProvider = Literal["gmail", "outlook"]


@dataclass(frozen=True)
class Attachment:
    """The resume the application mentions."""
    filename: str
    content: bytes

    @property
    def mime_type(self) -> str:
        return mimetypes.guess_type(self.filename)[0] or "application/octet-stream"


class Mailer(Protocol):
    """A delivery channel: Telegram (to the user's chat) or a mail provider (to the company)."""

    async def send(self, to_email: str, subject: str, text: str, attachments: list[Attachment] | None = None,
                   *, from_name: str = "") -> tuple[Status, str]: ...


def build_message(to_email: str, subject: str, text: str, attachments: list[Attachment] | None = None, *,
                  from_addr: str = "", from_name: str = "") -> EmailMessage:
    """The plain-text email with its attachments. Without `from_addr` there is no From header (Gmail's API
    fills in the signed-in account)."""
    msg = EmailMessage()
    if from_addr:
        msg["From"] = formataddr((from_name, from_addr)) if from_name else from_addr
        msg["Message-ID"] = make_msgid(domain=from_addr.rsplit("@", 1)[-1])
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(text)
    for a in attachments or []:
        maintype, subtype = a.mime_type.split("/", 1)
        msg.add_attachment(a.content, maintype=maintype, subtype=subtype, filename=a.filename)
    return msg


# ── stored OAuth tokens ───────────────────────────────────────────────────────

def token_path(provider: OAuthProvider) -> Path:
    return sqlite.db_path().parent / "mail_tokens" / f"{provider}.json"


def load_token(provider: OAuthProvider) -> dict | None:
    """What `mail_setup.py connect` saved ({"refresh_token", "email", ...}), or None."""
    try:
        data = json.loads(token_path(provider).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("refresh_token") else None


def save_token(provider: OAuthProvider, data: dict) -> None:
    """Write the token file atomically (a crash mid-write never leaves half a file)."""
    path = token_path(provider)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({**data, "saved_at": sqlite.utc_now()}, indent=2), encoding="utf-8")
    os.replace(tmp, path)


class MailAuthError(Exception):
    """No access token could be had: the stored sign-in was revoked or expired, or the client id is wrong."""


class OAuthToken:
    """An access token for one provider, refreshed from the stored refresh token when it is about to expire.
    A rotated refresh token (Microsoft sends a new one with every refresh) is saved back to the token file."""

    def __init__(self, http: HttpClient, provider: OAuthProvider, token_url: str, client_id: str,
                 client_secret: str = "", scope: str = "") -> None:
        stored = load_token(provider)
        if stored is None:
            raise RuntimeError(f"{provider}: not connected; run `python mail_setup.py connect {provider}` once "
                               f"(saves {token_path(provider)})")
        self.provider = provider
        self.email: str = stored.get("email") or ""
        self._stored = stored
        self._http = http
        self._token_url = token_url
        self._client_id = client_id
        self._client_secret = client_secret
        self._scope = scope
        self._access = ""
        self._expires_at = 0.0
        self._lock = asyncio.Lock()

    def invalidate(self) -> None:
        """The API refused the access token (401): get a new one next time."""
        self._expires_at = 0.0

    async def get(self) -> str:
        """A valid access token. Raises MailAuthError (signed out: reconnect) or httpx.HTTPError (network)."""
        async with self._lock:
            if self._access and time.monotonic() < self._expires_at:
                return self._access
            form = {"grant_type": "refresh_token", "refresh_token": self._stored["refresh_token"],
                    "client_id": self._client_id}
            if self._client_secret:
                form["client_secret"] = self._client_secret
            if self._scope:
                form["scope"] = self._scope
            resp = await self._http.post(self._token_url, data=form, timeout=30)
            if resp.status_code != 200:
                raise MailAuthError(f"{self.provider}: token refresh refused (HTTP {resp.status_code}: "
                                    f"{resp.text[:200]}); run `python mail_setup.py connect {self.provider}` again")
            body = resp.json()
            self._access = body["access_token"]
            self._expires_at = time.monotonic() + float(body.get("expires_in", 3600)) - 120
            if body.get("refresh_token") and body["refresh_token"] != self._stored["refresh_token"]:
                self._stored = {**self._stored, "refresh_token": body["refresh_token"]}
                try:
                    save_token(self.provider, self._stored)
                except OSError as exc:  # the old refresh token keeps working for a while
                    slog(f"[{self.provider}] could not save the new refresh token: {exc}", level=logging.WARNING)
            return self._access


class OAuthMailer:
    """A mail provider reached over HTTPS with an OAuth bearer token (Gmail's API, Microsoft Graph).

    `send` builds one request (`_request`), retries it only when it certainly didn't go through (no connection,
    429 / 5xx, an expired access token), and reads the answer (`_outcome`). A timeout once the request was sent
    is UNCERTAIN, never retried."""

    api: Api
    RETRYABLE = frozenset({429, 500, 502, 503, 504})

    def __init__(self, http: HttpClient, token: OAuthToken, *, attempts: int = 3) -> None:
        self._http = http
        self._token = token
        self.attempts = attempts

    async def _request(self, access_token: str, to_email: str, subject: str, text: str,
                       attachments: list[Attachment] | None, from_name: str) -> httpx.Response:
        raise NotImplementedError

    def _outcome(self, resp: httpx.Response) -> tuple[Status, str]:
        raise NotImplementedError

    async def send(self, to_email: str, subject: str, text: str, attachments: list[Attachment] | None = None,
                   *, from_name: str = "") -> tuple[Status, str]:
        resp: httpx.Response | None = None
        for attempt in range(1, self.attempts + 1):
            try:
                access = await self._token.get()       # outside the limiter: it is not a send
            except MailAuthError as exc:
                return SEND_FAILED, str(exc)
            except httpx.HTTPError as exc:
                if attempt < self.attempts:
                    await self._wait(attempt, None, f"token refresh: {type(exc).__name__}")
                    continue
                return SEND_FAILED, f"token refresh: {type(exc).__name__}: {exc}"
            try:
                async with limit(self.api):
                    resp = await self._request(access, to_email, subject, text, attachments, from_name)
            except httpx.HTTPError as exc:
                if not is_connect_failure(exc):       # it may have reached the provider
                    return UNCERTAIN, f"{type(exc).__name__}: {exc}"
                if attempt < self.attempts:
                    await self._wait(attempt, None, type(exc).__name__)
                    continue
                return SEND_FAILED, f"{type(exc).__name__}: {exc}"
            if resp.status_code == 401 and attempt < self.attempts:
                self._token.invalidate()
                continue
            if resp.status_code in self.RETRYABLE and attempt < self.attempts:
                await self._wait(attempt, retry_after(resp), f"HTTP {resp.status_code}")
                continue
            break
        assert resp is not None
        return self._outcome(resp)

    async def _wait(self, attempt: int, retry_after_secs: float | None, why: str) -> None:
        wait = max(2.0 * 2 ** (attempt - 1), retry_after_secs or 0)
        slog(f"[{self.api}] {why}; retrying in {wait:.0f}s", level=logging.WARNING)
        await asyncio.sleep(wait)


def retry_after(resp: httpx.Response) -> float | None:
    """The Retry-After header in seconds, if it is a number."""
    try:
        return float(resp.headers.get("Retry-After", ""))
    except ValueError:
        return None
