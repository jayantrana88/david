"""Microsoft Graph client: sends each application from the candidate's Outlook.com / Hotmail / Microsoft 365
account, resume attached.

Auth is OAuth 2.0 (delegated `Mail.Send`): an app registered in Microsoft Entra with the "Mobile and desktop
applications" platform and the redirect URI http://localhost (OUTLOOK_CLIENT_ID in credentials.env;
OUTLOOK_CLIENT_SECRET only for a "Web" registration; OUTLOOK_TENANT, default "common"), and a refresh token
saved once by `python mail_setup.py connect outlook`. Microsoft rotates the refresh token on every refresh;
the new one is saved back to the token file.

Graph's sendMail takes the attachment inline, so the whole request must stay under 4 MB (a 3 MB resume).

    status, detail = await get_outlook().send("jane@acme.com", "Subject", "Body", [Attachment("cv.pdf", data)])
"""

from __future__ import annotations

import base64

import httpx

from apis.mail import REJECTED, SEND_FAILED, SENT, Attachment, OAuthMailer, OAuthToken, Status
from config import credentials
from core.http import HttpClient

LOGIN_URL = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/{endpoint}"
SEND_URL = "https://graph.microsoft.com/v1.0/me/sendMail"
ME_URL = "https://graph.microsoft.com/v1.0/me"
SCOPES = "offline_access https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read"


def login_url(endpoint: str, tenant: str = credentials.outlook_tenant) -> str:
    return LOGIN_URL.format(tenant=tenant or "common", endpoint=endpoint)


class OutlookClient(OAuthMailer):
    api = "outlook"

    def __init__(self, http: HttpClient, client_id: str = credentials.outlook_client_id,
                 client_secret: str = credentials.outlook_client_secret, *, attempts: int = 3) -> None:
        if not client_id:
            raise RuntimeError("OutlookClient: missing on the dashboard's Settings page: OUTLOOK_CLIENT_ID")
        token = OAuthToken(http, "outlook", login_url("token"), client_id, client_secret, SCOPES)
        super().__init__(http, token, attempts=attempts)

    async def _request(self, access_token: str, to_email: str, subject: str, text: str,
                       attachments: list[Attachment] | None, from_name: str) -> httpx.Response:
        message = {
            "subject": subject,
            "body": {"contentType": "Text", "content": text},
            "toRecipients": [{"emailAddress": {"address": to_email}}],
            "attachments": [{"@odata.type": "#microsoft.graph.fileAttachment", "name": a.filename,
                             "contentType": a.mime_type, "contentBytes": base64.b64encode(a.content).decode()}
                            for a in attachments or []],
        }
        return await self._http.post(SEND_URL, json={"message": message, "saveToSentItems": True}, timeout=60,
                                     headers={"Authorization": f"Bearer {access_token}"})

    def _outcome(self, resp: httpx.Response) -> tuple[Status, str]:
        if resp.status_code == 202:     # accepted; Graph returns no message id
            return SENT, resp.headers.get("request-id", "")
        detail = f"HTTP {resp.status_code}: {resp.text[:300]}"
        if resp.status_code == 400 and "errorinvalidrecipients" in resp.text.lower():
            return REJECTED, detail
        return SEND_FAILED, detail
