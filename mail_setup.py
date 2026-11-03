"""Set up and try the email pool's delivery channels (config.py -> EMAIL.delivery).

    python mail_setup.py connect gmail      # sign in once in the browser; saves data/mail_tokens/gmail.json
    python mail_setup.py connect outlook    # likewise, data/mail_tokens/outlook.json
    python mail_setup.py test gmail --to you@example.com [--resume my_cv.pdf]
                                            # one sample application through that channel (telegram, gmail,
                                            # or outlook): really sent, to the address you give

`connect` runs OAuth's authorization-code flow with PKCE on a loopback redirect: a one-shot local web server
receives Google's / Microsoft's answer, the refresh token is saved for the daemon (core/clients.py ->
get_gmail / get_outlook), and the access tokens are refreshed from it from then on. Needs, on the dashboard's
Settings page (API keys):

  gmail     the Gmail client ID and secret: Google Cloud console → enable the Gmail API → OAuth consent
            screen (add your address as a test user, or publish the app: a "Testing" app's sign-in expires
            after 7 days) → Credentials → OAuth client ID → "Desktop app".
  outlook   the Outlook client ID: Microsoft Entra admin center → App registrations → New (accounts: "any
            organizational directory and personal Microsoft accounts") → Authentication → add platform
            "Mobile and desktop applications" with redirect URI http://localhost → API permissions: Microsoft
            Graph, delegated Mail.Send and User.Read.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import http.server
import json
import secrets
import sys
import threading
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

from apis import gmail, outlook
from apis.mail import Attachment, save_token, token_path
from config import credentials
from core.clients import aclose_all, get_mailer

SIGN_IN_TIMEOUT = 300       # seconds to finish signing in in the browser

SAMPLE_BODY = """Hi Acme team,

This is a test application from the job applier, sent to check that {channel} delivery works. The daemon
sends each application exactly like this one, with the resume attached when there is one.

Nothing else will be sent by this test.

Best regards,
{name}"""


# ── connect ───────────────────────────────────────────────────────────────────

class _Catch(http.server.BaseHTTPRequestHandler):
    """Receives the one redirect from the provider and keeps its query string."""
    result: dict = {}

    def do_GET(self) -> None:
        query = parse_qs(urlparse(self.path).query)
        if "code" not in query and "error" not in query:      # a favicon or similar
            self.send_response(404)
            self.end_headers()
            return
        type(self).result = {k: v[0] for k, v in query.items()}
        ok = "code" in query
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(("<h3>Connected. You can close this tab.</h3>" if ok else
                          "<h3>Sign-in failed. See the terminal.</h3>").encode())

    def log_message(self, *_args) -> None:
        pass


def _sign_in(auth_url: str, params: dict, host: str) -> tuple[str, str, str]:
    """Open the provider's sign-in page and wait for its redirect. Returns (code, redirect_uri, verifier)."""
    server = http.server.HTTPServer(("127.0.0.1", 0), _Catch)
    redirect_uri = f"http://{host}:{server.server_port}/"
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(16)
    url = auth_url + "?" + urlencode({**params, "response_type": "code", "redirect_uri": redirect_uri,
                                      "state": state, "code_challenge": challenge,
                                      "code_challenge_method": "S256"})
    _Catch.result = {}
    server.timeout = SIGN_IN_TIMEOUT
    thread = threading.Thread(target=server.handle_request, daemon=True)
    thread.start()
    print(f"Opening the sign-in page. If no browser opens, visit:\n\n  {url}\n")
    webbrowser.open(url)
    thread.join(SIGN_IN_TIMEOUT + 5)
    server.server_close()
    got = _Catch.result
    if not got:
        sys.exit("No answer from the browser in time; run the command again.")
    if "error" in got:
        sys.exit(f"Sign-in failed: {got['error']}: {got.get('error_description', '')}")
    if got.get("state") != state:
        sys.exit("Sign-in answer didn't match this request (state); run the command again.")
    return got["code"], redirect_uri, verifier


def _jwt_claims(token: str) -> dict:
    """The payload of an ID token (received straight from the provider over TLS, so not verified here)."""
    try:
        payload = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (IndexError, ValueError):
        return {}


def _exchange(token_url: str, form: dict) -> dict:
    resp = httpx.post(token_url, data=form, timeout=30)
    if resp.status_code != 200:
        sys.exit(f"Token exchange refused (HTTP {resp.status_code}): {resp.text[:500]}")
    body = resp.json()
    if not body.get("refresh_token"):
        sys.exit("The provider sent no refresh token (Google: remove the app's access at "
                 "myaccount.google.com/permissions and run this again).")
    return body


def connect_gmail() -> None:
    if not (credentials.gmail_client_id and credentials.gmail_client_secret):
        sys.exit("Save the Gmail client ID and secret on the dashboard's Settings page first (see the top of this file).")
    code, redirect_uri, verifier = _sign_in(gmail.AUTH_URL, {
        "client_id": credentials.gmail_client_id, "scope": gmail.SCOPES,
        "access_type": "offline", "prompt": "consent",          # always hand out a refresh token
    }, host="127.0.0.1")
    body = _exchange(gmail.TOKEN_URL, {
        "grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri, "code_verifier": verifier,
        "client_id": credentials.gmail_client_id, "client_secret": credentials.gmail_client_secret})
    email = _jwt_claims(body.get("id_token", "")).get("email", "")
    save_token("gmail", {"refresh_token": body["refresh_token"], "email": email, "scope": body.get("scope", "")})
    print(f"Connected Gmail{f' ({email})' if email else ''}. Saved {token_path('gmail')}.")


def connect_outlook() -> None:
    if not credentials.outlook_client_id:
        sys.exit("Save the Outlook client ID on the dashboard's Settings page first (see the top of this file).")
    code, redirect_uri, verifier = _sign_in(outlook.login_url("authorize"), {
        "client_id": credentials.outlook_client_id, "scope": outlook.SCOPES, "response_mode": "query",
        "prompt": "select_account",
    }, host="localhost")
    form = {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri,
            "code_verifier": verifier, "client_id": credentials.outlook_client_id, "scope": outlook.SCOPES}
    if credentials.outlook_client_secret:
        form["client_secret"] = credentials.outlook_client_secret
    body = _exchange(outlook.login_url("token"), form)
    me = httpx.get(outlook.ME_URL, headers={"Authorization": f"Bearer {body['access_token']}"}, timeout=30)
    email = (me.json().get("mail") or me.json().get("userPrincipalName") or "") if me.status_code == 200 else ""
    save_token("outlook", {"refresh_token": body["refresh_token"], "email": email, "scope": body.get("scope", "")})
    print(f"Connected Outlook{f' ({email})' if email else ''}. Saved {token_path('outlook')}.")


# ── test ──────────────────────────────────────────────────────────────────────

async def send_test(channel: str, to: str, resume: Path | None) -> int:
    try:
        mailer = get_mailer(channel)
        attachments = [Attachment(resume.name, resume.read_bytes())] if resume else None
        name = "The job applier"
        status, detail = await mailer.send(to, f"Test application ({channel})",
                                           SAMPLE_BODY.format(channel=channel, name=name), attachments,
                                           from_name=name)
    except RuntimeError as exc:
        print(f"{channel} isn't set up: {exc}")
        return 1
    finally:
        await aclose_all()
    print(f"{channel}: {status} {detail}")
    return 0 if status == "sent" else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Connect and test the email pool's delivery channels.")
    sub = parser.add_subparsers(dest="command", required=True)
    c = sub.add_parser("connect", help="sign in to Gmail or Outlook once (saves a refresh token)")
    c.add_argument("provider", choices=["gmail", "outlook"])
    t = sub.add_parser("test", help="send one sample application through a channel")
    t.add_argument("channel", choices=["telegram", "gmail", "outlook"])
    t.add_argument("--to", required=True, help="the address the sample goes to (yours)")
    t.add_argument("--resume", type=Path, help="attach this file")
    args = parser.parse_args()

    if args.command == "connect":
        {"gmail": connect_gmail, "outlook": connect_outlook}[args.provider]()
        return 0
    return asyncio.run(send_test(args.channel, args.to, args.resume))


if __name__ == "__main__":
    sys.exit(main())
