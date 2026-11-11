"""Gmail API client: sends each application from the candidate's own Gmail account, resume attached.

Auth is OAuth 2.0 with the `gmail.send` scope: a Google Cloud "Desktop app" OAuth client (the Gmail client ID /
secret on the dashboard's Settings page) and a refresh token saved once by `python mail_setup.py connect gmail`.
The message goes up as raw MIME through the upload endpoint (up to 35 MB), so it is exactly what was built.

    status, detail = await get_gmail().send("jane@acme.com", "Subject", "Body", [Attachment("cv.pdf", data)])
"""

from __future__ import annotations

import httpx

from apis.mail import REJECTED, SEND_FAILED, SENT, Attachment, OAuthMailer, OAuthToken, Status, build_message
from config import credentials
from core.http import HttpClient

TOKEN_URL = "https://oauth2.googleapis.com/token"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
SEND_URL = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media"
SCOPES = "https://www.googleapis.com/auth/gmail.send openid email"   # openid email: the address, for From


class GmailClient(OAuthMailer):
    api = "gmail"

    def __init__(self, http: HttpClient, client_id: str = credentials.gmail_client_id,
                 client_secret: str = credentials.gmail_client_secret, *, attempts: int = 3) -> None:
        missing = [name for name, value in {"GMAIL_CLIENT_ID": client_id, "GMAIL_CLIENT_SECRET": client_secret}.items()
                   if not value]
        if missing:
            raise RuntimeError(f"GmailClient: missing on the dashboard's Settings page: {', '.join(missing)}")
        super().__init__(http, OAuthToken(http, "gmail", TOKEN_URL, client_id, client_secret), attempts=attempts)

    async def _request(self, access_token: str, to_email: str, subject: str, text: str,
                       attachments: list[Attachment] | None, from_name: str) -> httpx.Response:
        msg = build_message(to_email, subject, text, attachments, from_addr=self._token.email, from_name=from_name)
        return await self._http.post(SEND_URL, content=msg.as_bytes(), timeout=60,
                                     headers={"Authorization": f"Bearer {access_token}",
                                              "Content-Type": "message/rfc822"})

    def _outcome(self, resp: httpx.Response) -> tuple[Status, str]:
        if resp.status_code == 200:
            return SENT, str(resp.json().get("id", ""))
        detail = f"HTTP {resp.status_code}: {resp.text[:300]}"
        # 400 "Invalid To header": the address itself is unusable, so this lead is done
        if resp.status_code == 400 and "invalid to header" in resp.text.lower():
            return REJECTED, detail
        return SEND_FAILED, detail
