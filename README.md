<div align="center">

# DAVID

**D**irect **A**pplications **V**ia **I**ntelligent **D**iscovery

### Skip the Goliaths. Apply straight to small companies.

DAVID finds small companies in the field and place you choose and checks that each one plausibly has work for you.<br>
Then it writes each of them a short, personal application with your resume attached.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jayantrana88/david)

![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-3776ab?logo=python&logoColor=white)
![Runs on Cloudflare Workers](https://img.shields.io/badge/also%20runs%20on-Cloudflare%20Workers-f38020?logo=cloudflare&logoColor=white)
![Status: beta](https://img.shields.io/badge/status-beta-yellow.svg)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

[Features](#features) · [How it works](#how-it-works) · [Run it](#run-it) · [Dashboard](#dashboard) · [Troubleshooting](#troubleshooting) · [Contributing](#contributing)

</div>

> [!WARNING]
> **DAVID is in beta.** The offline test suites pass, but runs against the live services have been limited so far. It starts in **dry run**, which saves every application as a draft and sends nothing. Read the drafts before you switch to sending. See [Project status](#project-status).

## Contents

- [Why DAVID](#why-david)
- [Who it's for](#who-its-for)
- [Features](#features)
- [How it works](#how-it-works)
- [Run it](#run-it)
- [Dashboard](#dashboard)
- [Sending applications](#sending-applications)
- [Configuration](#configuration)
- [Use it responsibly](#use-it-responsibly)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [Known limits](#known-limits)
- [Project status](#project-status)
- [Contributing](#contributing)

## Why DAVID

Big companies post openings that draw hundreds of applicants and run them through screening software. Small companies often have work but never post it, and their founder or a small team reads their inbox. DAVID goes after the small companies. It reads each one's website and writes it an application based on the company and on your resume.

| | Applying through job boards | DAVID |
| --- | --- | --- |
| **Where you apply** | Posted openings that every other applicant also sees | Small companies (50 employees or fewer by default), whether or not they posted a role |
| **Who reads it** | Often a screening system first | Usually the people who run the company |
| **Each application** | A generic cover letter, or an hour of your time | Written for that company from its own website and your profile |
| **Your effort** | Search, read, write and send, one at a time | Add a task ("software company in Bengaluru, 20 companies"), then review the drafts |
| **Cost** | Free, or a premium plan | Your own API keys (Serper and Jina have free allowances); the Cloudflare version runs on the free plan |

## Who it's for

| Who | What DAVID does for them |
| --- | --- |
| **Students** | Looks for internships: set the opportunity type to *internship* on your profile or on a single task |
| **Early-career job seekers** | Reaches companies too small to advertise, where one application gets read |
| **Career switchers** | Each task can target a different role, overriding the role on your profile |
| **People tied to a city** | Searches a city with a metro radius, or a whole region or country |

DAVID is not a mass mailer. Each company gets one application, a daily cap limits how many go out, and nothing is sent until you turn sending on.

## Features

**Finding companies**
- Searches public LinkedIn company pages through Google (Serper) for the category and location you give it.
- Keeps only companies whose LinkedIn size band ends at or below your limit, and only those inside the place you searched (an offline gazetteer, with a metro radius for cities).
- Skips companies whose website doesn't load, and companies it has already found.

**Checking fit**
- Reads each company's homepage and asks the AI whether the company plausibly has work for you, given your profile.
- Reads up to 5 more pages (about, services, team) of each company that fits, for material to write from.

**Writing**
- Builds your career profile from your resume (PDF or DOCX) and your notes. You can edit every field.
- Writes 2 or 3 short paragraphs (70 to 140 words) that mention the attached resume and contain only your own links. A draft that breaks a rule is rewritten.
- Follows your own writing instructions from the dashboard on top of those rules.

**Delivery**
- **Dry run** (the default): saves every application as a draft for you to review.
- **Telegram:** posts each application to your own chat with copy buttons, and you send it yourself.
- **Gmail / Outlook:** emails the company from your own account, with the resume attached.

**Control**
- A web dashboard for your profile, tasks, companies, drafts and settings.
- A daily send cap, and a guarantee that a company is never emailed twice.
- Runs on your own PC, or on Cloudflare's free plan with nothing to install.

## How it works

DAVID runs five **stages** in one process. They never call each other: each stage watches its own queue in the database, so a company moves on by itself once the previous stage has saved its result.

```
tasks ──▶ sourcing ──▶ websites ──▶ scrape ──▶ website_scrapes ──(fits)──▶ internal ──▶ website_pages ──▶ email ──▶ cold_emails
```

| Stage | What it does | Uses |
| --- | --- | --- |
| **Profile** | Reads your resume and notes into a career profile (name, roles, skills, job or internship, links). The scrape and email stages wait until it's ready. | AI |
| **Sourcing** | Runs each task you add, oldest first. It finds companies on LinkedIn, keeps the ones in the size band whose website answers, and saves them. | Serper, LinkedIn pages |
| **Scrape** | Reads each new company's homepage, has the AI decide whether it fits you, and saves any email addresses on the page. | Jina Reader, AI |
| **Internal** | Reads up to 5 internal pages of each company that fits. | Jina Reader |
| **Email** | Writes the application from those pages and your profile, checks it against the rules, and saves or delivers it. | AI, then Telegram, Gmail or Outlook |

Everything is stored in one SQLite file, `daemon/data/david.db`, which is created on first start. The table and code names are older than the name DAVID: a company is a "lead" in a `websites` row, and an application is a `cold_emails` row.

<details>
<summary>What happens when something fails</summary>

All five stages share one loop, `Worker` in [daemon/core/worker.py](daemon/core/worker.py). It loads the queue, drops what is finished or waiting to retry, runs a batch and records each item's outcome:

| Outcome | What DAVID does |
| --- | --- |
| **Success** | The item's row now exists, so it leaves the queue |
| **Failure** (a page didn't load, the AI didn't answer) | Retried after an hour. Kept in memory only, with no attempt limit |
| **Permanent failure** (no draft passed the rules) | Not retried |
| **Skipped** (no usable email address) | Left alone until the daemon restarts |
| **AI key rejected** | The stage pauses for 15 minutes instead of failing every company |
| **Every AI model out of quota** | The stage pauses until the earliest reset |
| **15 failures in a row** (5 for email) | The stage pauses for 10 minutes. Usually Jina, the AI or a key's credit is down |

Scrape failures are saved as data rather than raised:
- A homepage Jina can't read is saved as not fitting, and never retried.
- A homepage the AI couldn't judge is saved with its text and stays in the queue. Next time only the AI is asked, with no second Jina read.

The internal stage works the same way: if none of a company's pages can be read, it saves a placeholder that the queue offers again later.

**AI batching.** The scrape stage's fit checks and the email stage's first drafts are sent to the AI several at a time (`AI.qualify_batch` / `AI.email_batch`). Any company a batch reply doesn't answer clearly is asked again on its own, never guessed. A draft that fails the rules is always rewritten on its own.

</details>

<details>
<summary>Project layout</summary>

```
daemon/                 the local Python daemon
  main.py                 entry point: starts one worker per stage, shuts down gracefully
  config.py               the settings file: credentials, rate limits, logging, AI providers, email mode
  core/                   shared plumbing: the Worker loop, the database (db.py, sqlite.py), the AI client and
                          batching (llm.py), rate limits, logging, retries, the HTTP pool, the client getters
                          (clients.py), the config models and the dashboard-settings loader
  apis/                   one module per outside service: Jina (+ parsing its replies), Serper, Telegram,
                          Gmail, Outlook (+ mail.py, what they share), the headless browser, the website check
  prompts/                every AI prompt, the JSON schema of its reply and the parser of that reply
  stages/                 profile/ sourcing/ (+ linkedin/) scrape/ internal/ email/
  db/schema.sql           every table, applied automatically whenever the database is opened
  data/                   david.db and resumes/ (uploaded resumes); git-ignored
  tests/                  pytest suite (no network: a fake AI and a fake Jina)
  test_email.py           manual harness: one company, real APIs, nothing saved or sent
dashboard/              Next.js web UI over the same SQLite file
src/ migrations/ test/  the same pipeline as one Cloudflare Worker (wrangler.jsonc, package.json at the
wrangler.jsonc ...      repo root; see docs/cloudflare.md)
```

Each stage has the same files in `daemon/stages/<stage>/`:

| File | What it holds |
| --- | --- |
| `store.py` | All of the stage's SQL: its queue query and the rows it writes |
| `run.py` | The stage's logic: dataclasses in, dataclasses out, no database |
| `worker.py` | `make_worker(db)`: load from the store, run, save to the store |
| `models.py` | The dataclasses (queue item, result) |

</details>

## Run it

There are two ways to run DAVID. Both use the same stages and the same tables.

| | On Cloudflare (free plan) | On your own machine |
| --- | --- | --- |
| **Setup** | Click **Deploy to Cloudflare** | Python, Node and a few commands |
| **Runs** | Around the clock, with no PC to keep on | While `python daemon/main.py` is running |
| **AI** | Workers AI, with no key needed | Any provider [LiteLLM](https://docs.litellm.ai/docs/providers) supports |
| **LinkedIn pages** | Plain fetch from Cloudflare (LinkedIn blocks datacenter IPs often; Browser Rendering needs Workers Paid) | Your installed Chrome, from your own connection |
| **Dashboard** | On a public URL, behind a password | On `127.0.0.1`, with an optional password |

### On Cloudflare

**1. Click Deploy to Cloudflare** at the top of this page, then sign in. The deploy asks for nothing else. The dashboard starts open; if you want it locked, set a password on its **Settings** page (it is optional, and you can remove it again).

**2. Open the Worker's URL**, then upload your resume on **Profile** and add your [Serper](https://serper.dev) key in **Settings → API keys**.

**3. Add a task** on **Tasks**, and watch the drafts arrive.

[docs/cloudflare.md](docs/cloudflare.md) covers the details: the delivery channels, the free-tier budget, and how the Worker differs from the local daemon.

### On your own machine

#### Requirements

- Python 3.10 or newer
- Node 22.5 or newer, for the dashboard (it uses the built-in `node:sqlite`)
- Google Chrome, which fetches the LinkedIn pages. Without it, run `playwright install chromium` and set `Settings.browser_channel=None` in [daemon/stages/sourcing/linkedin/settings.py](daemon/stages/sourcing/linkedin/settings.py)

#### Steps

**1. Install the daemon**

```powershell
python -m venv venv
venv\Scripts\activate
pip install -r daemon/requirements.txt
```

**2. Start the dashboard**

```powershell
cd dashboard
npm install
npm run dev            # http://127.0.0.1:3000   (or: npm run build && npm start)
```

**3. Add your keys** in **Settings**. There is no config file for them. They are saved in the local database, and the daemon restarts itself to use them.

| Key | Needed by | Where to get it |
| --- | --- | --- |
| AI provider key, plus a model or a Cloudflare account ID | profile, scrape, email | The model is any [LiteLLM](https://docs.litellm.ai/docs/providers) string (`<provider>/<model>`). Leave it empty to use Cloudflare Workers AI's Gemma, which needs the account ID |
| Jina Reader key | scrape, internal | [jina.ai/reader](https://jina.ai/reader) |
| Serper key | sourcing | [serper.dev](https://serper.dev), 2,500 free searches |
| Telegram bot token + chat ID | Telegram delivery | Create a bot with @BotFather, message it once, and read the chat ID from `getUpdates` |
| Gmail client ID + secret | Gmail delivery | A Google Cloud OAuth client of type "Desktop app" with the Gmail API enabled. Then run `python daemon/mail_setup.py connect gmail` |
| Outlook client ID (+ secret for a "Web" registration) | Outlook delivery | A Microsoft Entra app registration. Then run `python daemon/mail_setup.py connect outlook` |

**4. Upload your resume** on **Profile**. Once the daemon is running (step 5), the profile stage reads it within about 15 seconds. Check the result and edit anything it got wrong.

**5. Start the daemon**

```powershell
python daemon/main.py                          # every stage
python daemon/main.py --pools scrape internal  # only some (profile sourcing scrape internal email)
```

**6. Add a task** on **Tasks**: a kind of company, a place, and how many companies to find.

> [!TIP]
> A stage whose key is missing doesn't start, and the others still run. `daemon/logs/main/main.log` names any stage that didn't start and why.

> [!IMPORTANT]
> The keys are stored as plain text in `daemon/data/david.db`. Keep that file, and any backup of it, private.

The only environment variable is the optional `DB_PATH`, the location of the SQLite file (default `daemon/data/david.db`). The daemon and the dashboard both read it; for the dashboard, put it in `dashboard/.env.local`. There is no database setup step: [daemon/db/schema.sql](daemon/db/schema.sql) is applied whenever the file is opened.

### Tasks

A task is one search: a company category, a location, how many companies to find (`candidates`) and, optionally, a maximum company size. Add tasks on the dashboard, or insert a row yourself:

```sql
insert into tasks (category, location, candidates) values ('software company', 'Bengaluru', 20);
-- optional: max_employees (default 50), metro_radius_km (default 30),
-- target_role and opportunity_type ('job' / 'internship' / 'either') to override the profile's
```

- The daemon checks for a pending task every 30 seconds and runs **one at a time**, oldest first.
- **completed**: the search ran to the end. `leads_saved` can be lower than `candidates` if the search results ran out; the reason is in `error`.
- **failed**: the reason is in `error`. Examples: an unrecognised location, LinkedIn blocking this IP, or the Serper key being refused. A failed task is not retried; re-run it from the dashboard.
- A task still running when the daemon stopped runs again in full at the next start. Companies it already saved are skipped.

## Dashboard

[dashboard/](dashboard/) is a Next.js web app over the same SQLite file. It listens on `127.0.0.1` only, so it is meant for your own machine.

| Page | What you can do |
| --- | --- |
| **Overview** | See counts for every stage |
| **Profile** | Upload a resume, edit the derived profile, read the resume again |
| **Tasks** | Add tasks (several categories × locations at once), edit a pending one, re-run or delete a finished one |
| **Websites** | See each company with its fit check and application; edit email, phone and owner; delete |
| **Scrapes** | Override the AI's verdict, or clear it so the AI judges again; delete, so the site is read again |
| **Pages** | Delete a company's pages so they are read again |
| **Cold emails** | Review drafts; retry an application that never went out |
| **Settings** | The AI model, delivery channel, daily send cap, your email writing rules, API keys, an optional dashboard password |

Every database call runs on the server, and API keys never reach the browser. The optional password is asked once per browser (for 30 days). After five wrong tries in a row, guessing is locked for a minute, then for longer.

## Sending applications

DAVID starts in **dry run**: every application is saved as a `draft` on the **Cold emails** page, and nothing is sent. When the drafts look right, set `mode="send"` in `daemon/config.py` → `EMAIL`, and choose a channel in **Settings → Email → Delivery**. Going live deletes the drafts, so those companies get a real application. (On Cloudflare, the mode is a setting on the dashboard.)

| Channel | What happens |
| --- | --- |
| **Telegram** (default) | Nothing is emailed to the company. Each application is posted to your Telegram chat with buttons that copy the address, the subject and the body, and you send it yourself. The body is split across a few buttons ("Body 1/4", ...) because a copy button holds at most 256 characters. It's also shown as a block that Telegram copies whole in one tap |
| **Gmail** | Emailed from your Gmail account through the Gmail API, with the resume attached |
| **Outlook** | Emailed from your Outlook account through Microsoft Graph, with the resume attached |

Before going live, send yourself one sample through the channel:

```powershell
python daemon/mail_setup.py test gmail --to you@example.com --resume cv.pdf
```

> [!NOTE]
> Personal mailboxes have daily limits (Gmail about 500, Outlook.com about 300). Set **Max sends per day** well below them. A Google app left in "Testing" status loses its sign-in after 7 days, so publish it or reconnect.

## Configuration

Keys, the AI model, the delivery channel, the daily send cap and your writing rules are set on the dashboard. The rest, including the email mode, is in [daemon/config.py](daemon/config.py), plain Python that is checked when the daemon starts; an unknown field or a bad value stops it with the field's name.

<details>
<summary>AI providers</summary>

There are three AI roles: `qualify` (the fit check), `email` (writing applications) and `profile` (reading the resume). All three use Gemma 4 on Cloudflare Workers AI by default. Each role lists its models in order of preference:

- **Out of quota:** when a model's daily quota runs out, it rests until the reset the provider gave, and the next model answers meanwhile.
- **Withdrawn model:** a model the provider no longer offers is skipped for 15 minutes at a time.
- **Every model resting:** the stage pauses until the earliest reset.
- **Per-minute limit:** retried on the same model.

To switch provider, change a role's `models` (any [LiteLLM model string](https://docs.litellm.ai/docs/providers)) and its key. No code change is needed. To test without the network, set `extra_params={"mock_response": '{"qualified": true}'}` on a role.

</details>

<details>
<summary>Rate limits</summary>

Each outside API has one limit for the whole daemon, in `daemon/config.py` → `RATE_LIMITS`:

| API | In flight | Per minute |
| --- | --- | --- |
| AI (every role shares one account) | 8 | 60 |
| Jina (scrape and internal share it) | 6 | 120 |
| Serper | 4 | 300 |
| LinkedIn | 1 | 40 |
| Telegram | 1 | 20 |
| Gmail / Outlook | 1 each | 6 each |

</details>

<details>
<summary>Logs and shutdown</summary>

- **Logs** are in `daemon/logs/`. `daemon/logs/main/main.log` records stages starting and pausing, queue sizes and task summaries, and is also printed to the console. `daemon/logs/<stage>/<stage>.log` has one line per company. Files rotate at midnight and are kept for 7 days. Set levels in `daemon/config.py` → `LOGGING`, or use `$env:LOG_LEVEL="DEBUG"` for one run (DEBUG also shows each AI call's token usage).
- **Shutdown:** Ctrl+C stops the stages from taking new work, and in-flight work gets 30 seconds to finish. Anything still running is picked up again at the next start.
- **Settings changes:** when you save a setting on the dashboard, the daemon finishes its current work and restarts itself with the new settings.

</details>

## Use it responsibly

> [!CAUTION]
> DAVID sends email in your name to people who didn't ask for it. Keep the volume low and the applications honest.

- **LinkedIn's terms.** DAVID reads public LinkedIn company pages, and LinkedIn's User Agreement restricts automated access. LinkedIn blocks IPs that fetch too much. Keep tasks small, and respect a block when it happens.
- **Your mailbox.** Providers can suspend an account that sends many similar emails or gets marked as spam. Use a modest daily cap.
- **The law where you are.** Many countries regulate unsolicited email (for example CAN-SPAM in the US, the GDPR and ePrivacy rules in the EU, CASL in Canada). Check what applies to you and to the companies you write to.
- **What the AI writes.** The rules check the shape of an email, not whether it's true. Read the drafts in dry run, and fix your profile if it overstates anything.

DAVID is provided as is. You are responsible for how you use it and for every email it sends.

## Updating

Pull the new code, then run `pip install -r daemon/requirements.txt`, and `npm install` in `dashboard/`. Restart the daemon. New columns are added to your existing database automatically when it is opened, so your data stays.

For the Cloudflare version, see [docs/cloudflare.md](docs/cloudflare.md). `npm run deploy` applies any new migrations to D1.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| A stage never does anything | Its key is probably missing. `daemon/logs/main/main.log` names the stages that didn't start |
| Scrape and email stay empty | The profile isn't ready. Check **Profile**: upload a resume, or fix the error shown there |
| A task failed with an unrecognised location | Use a city, region or country name as it appears on a map, for example *Bengaluru* or *Karnataka* |
| A task failed because LinkedIn blocked it | Wait a while, then re-run the task. Companies already saved are skipped |
| No applications are being sent | `EMAIL.mode` is still `dry_run`, the daily cap has been reached, or no resume has been uploaded (the email stage waits for one) |
| The AI stages pause for hours | Every model is out of its daily quota. Add a second model or provider |
| Gmail stopped sending after a week | The Google app is still in "Testing". Publish it, or run `python daemon/mail_setup.py connect gmail` again |
| An application shows "check Sent folder" | Gmail or Outlook timed out after the email may have gone out. Check your Sent folder. DAVID won't send to that company again |

## Known limits

- **One process only.** Work in progress is tracked in memory. A second daemon on the same database would pick up the same companies.
- **No attempt limit.** A company that keeps failing is retried once an hour for as long as the daemon runs.
- **http-only sites fail.** Jina always fetches over `https://`, so a site that only serves `http://` fails the scrape stage.
- **Same domain, different path.** `brand.com/delhi` and `brand.com/mumbai` count as two companies, so a shared address can get two applications.
- **A lost Telegram reply** marks the application `send_failed`, so it's posted again. That's harmless, because it goes to your own chat.
- **A lost Gmail or Outlook reply** leaves the application as `sending`, and the company is never retried, because nobody should get the same email twice. An address the provider refuses for good is marked `rejected`.

## Project status

DAVID is in beta. The Python and Cloudflare test suites pass offline with a fake AI and fake services, but use against the live services (LinkedIn, the AI providers, Gmail and Outlook) has been limited so far.

- Start in dry run, and read the drafts before you send anything.
- Try the delivery channel on yourself first with `python daemon/mail_setup.py test`.
- If something breaks, open an issue with the relevant lines from `daemon/logs/`.

## Contributing

Bug reports, fixes and new lead sources are welcome. A new source is a package under `daemon/stages/sourcing/`; [CLAUDE.md](CLAUDE.md) describes the contract.

1. Fork the repo and make your change.
2. If you change the prompts, the email rules or a queue, change the Cloudflare port in `src/` to match.
3. Run the tests before you open a pull request:

```powershell
pip install -r daemon/requirements-dev.txt
python -m pytest daemon                     # no network, no keys: a fake AI, a fake Jina, temporary databases
npm test; npm run typecheck
```

### Development setup

The tests cover the email rules, reading the AI's replies, the Worker's outcomes, each stage's queue query, the config checks, and a scrape and an email round against a fake AI. To try one company end to end against the real APIs without saving or sending anything:

```powershell
python daemon/test_email.py https://acme.com --resume my_cv.pdf [--notes "..."] [--role "Data Analyst"] [--type internship]
```
