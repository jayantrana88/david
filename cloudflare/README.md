# DAVID on Cloudflare (free plan)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jayantrana88/david/tree/main/cloudflare)

The same pipeline as the local daemon, as one Cloudflare Worker you can deploy with the button above. There is nothing to install and no PC to keep on. It finds small companies on LinkedIn, checks each one plausibly has work for you, and writes each an application with your resume attached. In dry run it saves drafts; in send mode it posts each application to your Telegram chat, or emails it from your Gmail or Outlook account.

| Piece | Local daemon | This Worker |
|---|---|---|
| Runtime | `python main.py`, one asyncio process | A cron trigger every minute; each tick runs one stage a small step |
| Database | `data/job_applier.db` (SQLite) | D1 (SQLite), same tables (`migrations/0001_init.sql`) |
| Resume | `data/resumes/` | Stored in D1 as base64 (up to 1.4 MB) |
| Resume to text | pypdf / python-docx | Workers AI `toMarkdown` (free for PDF and DOCX) |
| AI | LiteLLM, any provider | Workers AI binding (no key, Gemma 4 by default), or any OpenAI-compatible endpoint |
| LinkedIn pages | Playwright + your Chrome | Browser Rendering, or plain fetch |
| City gazetteer | geonamescache (bundled) | Open-Meteo geocoding (same GeoNames data), cached in D1 |
| Dashboard | Next.js on `127.0.0.1` | Server-rendered pages from the same Worker, behind a password |
| Gmail / Outlook sign-in | `python mail_setup.py connect` | Settings → Connect (web OAuth) |

## Deploy

1. **Push this repo to GitHub as a public repo.** The button reads `https://github.com/jayantrana88/david/tree/main/cloudflare`. If your repo or branch is named differently, change that URL here and in the root README.
2. **Click Deploy to Cloudflare** and sign in. You'll name the Worker and the D1 database, and set **`DASHBOARD_PASSWORD`**: the dashboard is on a public URL, so use at least 10 random characters (`openssl rand -base64 18`). Cloudflare then:
   - copies the repo to your account,
   - creates the D1 database,
   - runs `npm run deploy`, which applies `migrations/` to D1 and deploys the Worker with its cron.
3. **Open the Worker's URL and sign in.**
4. **Profile:** upload your resume (PDF or DOCX). The profile stage reads it within a minute or two.
5. **Settings → API keys:** add your [Serper](https://serper.dev) key. It's required: LinkedIn is searched through Google, and Serper gives 2,500 free searches. A Jina key is optional.
6. **Tasks:** add a kind of company and a place, for example *software company* in *Bengaluru*.
7. **Applications:** watch the drafts arrive. When they look right, go to Settings and switch the mode to **Send** with your delivery channel.

To deploy from your own machine instead: `npm install`, `npx wrangler login`, then `npx wrangler d1 create job-applier` and put its id in `wrangler.jsonc`. Then run `npx wrangler secret put DASHBOARD_PASSWORD` and `npm run deploy`.

### Delivery channels

- **Telegram** (default): create a bot with @BotFather, send it a message, then read your chat id from `https://api.telegram.org/bot<token>/getUpdates`. Save both keys in Settings. Each application arrives in your chat with copy buttons, and you send it yourself.
- **Gmail:**
  1. In Google Cloud, enable the Gmail API and set up the OAuth consent screen (add yourself as a test user).
  2. Create an OAuth client of type **Web application**, with the redirect URI shown in Settings: `https://<your worker>/oauth/gmail/callback`.
  3. Save the client ID and secret in Settings, then click **Connect**.
  4. A "Testing" app's sign-in expires after 7 days; publish the app to avoid that.
- **Outlook:**
  1. Register an app in Microsoft Entra (any directory plus personal accounts).
  2. Add the **Web** platform with the redirect URI shown in Settings.
  3. Create a client secret and add the delegated Graph permissions `Mail.Send` and `User.Read`.
  4. Save the ID and secret, then click **Connect**.

Use **Settings → Try a delivery channel** to send yourself one sample first.

## How it runs inside the free plan

A free Worker gets **10 ms of CPU and 50 outside requests per invocation**. Waiting on the network doesn't count as CPU. So every minute the cron runs one **tick**, which gives one stage a small step:

| Stage | Per tick | Outside requests |
|---|---|---|
| profile | the resume, when you upload or ask for a re-read | toMarkdown + 1 AI call (Cloudflare services) |
| sourcing | 1 Google results page and/or up to *LinkedIn pages per tick* companies (default 4) | Serper, LinkedIn, Open-Meteo, the company's site |
| scrape | up to *companies per AI call* homepages (default 10), judged in one AI call | Jina |
| internal | 2 companies, up to 5 pages each | Jina |
| email | up to *first drafts per AI call* companies (default 3) | Telegram / Gmail / Outlook |

The profile stage goes first when it has work. The others take turns, starting from a different one each minute. A stage with an empty queue is left alone for 10 minutes, unless the stage before it writes new work (it wakes it), or you press **Run now** on the Overview.

What the daemon keeps in memory, the Worker keeps in D1, because it forgets everything between ticks:
- **Where a search got to:** `tasks.cursor`, so a search carries on where the last tick stopped.
- **Stage holds:** an AI quota, a rejected key, LinkedIn blocking. These are in `stage_state`, shown on the Overview.
- **Items to retry after a while:** `backoff`. There are no attempt counters, just a time, the same as the daemon's `_retry_at`.
- **A per-stage lease,** so a tick that runs past the minute isn't run twice.

### Daily allowances (free plan)

- **Workers AI:** 10,000 neurons a day. When they're used up, the AI stages hold until midnight UTC; the Overview shows why. To go further, set an OpenAI-compatible provider in Settings → AI (a base URL, a model and an AI key; Groq and OpenRouter have free tiers).
- **Browser Rendering:** 10 browser-minutes a day, roughly 100 to 150 LinkedIn pages. When they're used up, sourcing holds until midnight UTC.
- **D1:** 5 GB, 5 million rows read and 100,000 written a day. That's far more than this uses.
- **Workers:** 100,000 requests a day. The cron uses 1,440.

### Known limits

- **LinkedIn blocks more on Cloudflare.** It refuses many requests from datacenter IPs. A refused page holds sourcing for 20 minutes and is retried once; three refusals in a row fail the task with the reason, the same as the daemon's run abort. Re-run it later, or switch Settings → Sourcing → *LinkedIn pages through*.
- **The website check is coarser.** A Worker can't tell a missing domain from a refused connection or a bad certificate, so all three count as unreachable.
- **The Deploy button doesn't list Browser Rendering among the resources it provisions.** The binding needs no resource of its own, so `wrangler deploy` sets it up. If your account doesn't have Browser Rendering, use *Plain fetch*.
- **Keys are stored as plain text in your D1 database.** The dashboard password is their only protection, the same as the local dashboard's.

## Develop

```sh
npm install
npm test                      # vitest: the ported logic (same cases as the Python tests) and every stage
                              # against the real migration on SQLite, with a fake AI and stubbed services
npm run typecheck
cp .dev.vars.example .dev.vars && npm run db:migrations:local
npm run dev                   # http://localhost:8787; trigger a tick at /__scheduled?cron=*+*+*+*+*
```

The AI binding runs only against your account (`wrangler dev --remote`). Locally the AI stages hold with "needs to be run remotely".

`src/` mirrors the daemon:
- `stages/<stage>.ts` holds each stage; `runner.ts` is `main.py` plus `core/worker.py`.
- `prompts.ts`, `llm.ts`, `jina.ts`, `mail/`, `sourcing/` (geo and LinkedIn) and `web/` (the dashboard) hold the rest.

Keep the prompts in `prompts.ts` in step with `../prompts/templates.py`. `src/sourcing/geo-data.ts` is generated from pycountry by `scripts/make_geo_data.py`.
