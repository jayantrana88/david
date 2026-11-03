import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowUpRight,
  CheckCircle2,
  FileText,
  Globe,
  ListChecks,
  Mail,
  Plus,
  ScanSearch,
  type LucideIcon,
} from "lucide-react";
import { getOverview, type Overview } from "@/lib/data/overview";
import { parseRange } from "@/lib/data/common";
import { num, pct, timeAgo } from "@/lib/format";
import { PageHeader, Panel } from "@/components/page-header";
import { EmailStatus, StatusBadge, TaskStatus, toneBg, toneSoft, type Tone } from "@/components/status-badge";
import { ErrorState } from "@/components/empty-state";
import { Time } from "@/components/time";
import { DateFilter } from "@/components/date-filter";
import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage(props: PageProps<"/">) {
  const range = parseRange(await props.searchParams);
  // Links into the process pages keep the chosen dates.
  const h = (path: string) => {
    const qs = [range.from && `from=${range.from}`, range.to && `to=${range.to}`].filter(Boolean).join("&");
    return qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
  };
  let data: Overview;
  try {
    data = await getOverview(range);
  } catch (e) {
    return (
      <>
        <PageHeader title="Overview" />
        <ErrorState message={(e as Error).message} />
      </>
    );
  }
  const { n } = data;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Where every lead stands in the pipeline, live from the database."
        actions={
          <Link href="/tasks/new" className={buttonVariants({ className: "h-9 gap-1.5 px-3.5" })}>
            <Plus className="size-4" /> New task
          </Link>
        }
      />

      <DateFilter base="/" from={range.from} to={range.to} />

      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={Globe} tone="brand" label="Leads sourced" value={n.websites} today={n.websitesToday} href={h("/websites")} />
        <Stat
          icon={CheckCircle2}
          tone="success"
          label="Qualified"
          value={n.qualified}
          today={n.qualifiedToday}
          note={n.qualified + n.rejected ? `${pct(n.qualified, n.qualified + n.rejected)}% qualification rate` : undefined}
          href={h("/scrapes?verdict=qualified")}
        />
        <Stat
          icon={FileText}
          tone="info"
          label="Pages read"
          value={n.pages}
          today={n.pagesToday}
          note={`for ${num(n.withPages)} lead${n.withPages === 1 ? "" : "s"}`}
          href={h("/pages")}
        />
        <Stat
          icon={Mail}
          tone="brand"
          label="Emails sent"
          value={n.email_sent}
          today={n.sentToday}
          note={`${num(n.emails)} written in all`}
          href={h("/emails?status=sent")}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <Panel
          title="Pipeline"
          description="Each lead moves down the pipeline as the daemon's pools work on it."
          className="flex flex-col"
        >
          <Funnel
            steps={[
              { label: "Sourced", value: n.websites, href: h("/websites") },
              { label: "Scraped", value: n.scrapes, href: h("/scrapes") },
              { label: "Qualified", value: n.qualified, href: h("/scrapes?verdict=qualified") },
              { label: "Pages read", value: n.withPages, href: h("/pages") },
              { label: "Emailed", value: n.email_sent, href: h("/emails?status=sent") },
            ]}
          />
          <dl className="mt-6 grid grid-cols-3 divide-x rounded-lg border bg-subtle">
            <Rate label="Qualification rate" value={pct(n.qualified, n.qualified + n.rejected)} />
            <Rate label="Qualified → emailed" value={pct(n.email_sent, n.qualified)} />
            <Rate label="Sourced → emailed" value={pct(n.email_sent, n.websites)} />
          </dl>
        </Panel>

        <Panel title="Waiting for work" description="What each pool will pick up next." flush>
          <ul className="divide-y">
            <Queue label="Tasks to run" pool="sourcing" value={n.task_pending} href={h("/tasks?status=pending")} />
            <Queue label="Websites to scrape" pool="scrape" value={n.unscanned} href={h("/websites")} />
            <Queue label="Awaiting AI verdict" pool="scrape" value={n.awaitingVerdict} href={h("/scrapes?verdict=pending")} />
            <Queue label="Qualified, pages not read" pool="internal" value={n.awaitingPages} href={h("/scrapes?verdict=qualified")} />
            <Queue label="Page reads to retry" pool="internal" value={n.failedPages} href={h("/pages?content=failed")} />
            <Queue label="Sends to retry" pool="email" value={n.email_send_failed} href={h("/emails?status=send_failed")} />
          </ul>
        </Panel>
      </div>

      {data.running && (
        <div className="mt-6 flex flex-wrap items-center gap-4 rounded-xl border border-info-ring bg-info-soft/60 px-5 py-4">
          <StatusBadge tone="info" pulse>
            Running
          </StatusBadge>
          <p className="min-w-0 flex-1 text-sm text-foreground">
            <span className="font-medium">{data.running.category}</span>
            <span className="text-muted-foreground"> in </span>
            <span className="font-medium">{data.running.location}</span>
            <span className="text-muted-foreground"> · started {timeAgo(data.running.started_at)}</span>
          </p>
          <div className="flex items-center gap-3">
            <div className="h-1.5 w-40 overflow-hidden rounded-full bg-card">
              <div
                className="h-full rounded-full bg-info transition-all"
                style={{ width: `${pct(data.running.leads_saved, data.running.candidates)}%` }}
              />
            </div>
            <span className="tabular text-[13px] text-secondary-foreground">
              {data.running.leads_saved} / {data.running.candidates} leads
            </span>
          </div>
        </div>
      )}

      {/* Tables */}
      <h2 className="mt-10 mb-4 text-[15px] font-semibold">Tables</h2>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <TableCard
          icon={ListChecks}
          title="Tasks"
          href={h("/tasks")}
          total={n.tasks}
          latest={data.latest.tasks}
          parts={[
            ["Pending", n.task_pending, "warning", h("/tasks?status=pending")],
            ["Running", n.task_running, "info", h("/tasks?status=running")],
            ["Completed", n.task_completed, "success", h("/tasks?status=completed")],
            ["Failed", n.task_failed, "danger", h("/tasks?status=failed")],
          ]}
        />
        <TableCard
          icon={Globe}
          title="Websites"
          href={h("/websites")}
          total={n.websites}
          latest={data.latest.websites}
          parts={[
            ["Has email", n.withEmail, "success", h("/websites?email=with")],
            ["No email", n.websites - n.withEmail, "neutral", h("/websites?email=without")],
          ]}
        />
        <TableCard
          icon={ScanSearch}
          title="Scrapes"
          href={h("/scrapes")}
          total={n.scrapes}
          latest={data.latest.website_scrapes}
          parts={[
            ["Qualified", n.qualified, "success", h("/scrapes?verdict=qualified")],
            ["Not a fit", n.rejected, "neutral", h("/scrapes?verdict=rejected")],
            ["Awaiting AI", n.awaitingVerdict, "warning", h("/scrapes?verdict=pending")],
          ]}
        />
        <TableCard
          icon={FileText}
          title="Pages"
          href={h("/pages")}
          total={n.pages}
          latest={data.latest.website_pages}
          parts={[
            ["Read", n.pages - n.failedPages, "success", h("/pages?content=read")],
            ["Failed read", n.failedPages, "warning", h("/pages?content=failed")],
          ]}
        />
        <TableCard
          icon={Mail}
          title="Cold emails"
          href={h("/emails")}
          total={n.emails}
          latest={data.latest.cold_emails}
          parts={[
            ["Sent", n.email_sent, "success", h("/emails?status=sent")],
            ["Drafts", n.email_draft, "neutral", h("/emails?status=draft")],
            ["Sending", n.email_sending, "info", h("/emails?status=sending")],
            ["Send failed", n.email_send_failed, "warning", h("/emails?status=send_failed")],
            ["Rejected", n.email_rejected, "danger", h("/emails?status=rejected")],
            ["Not written", n.email_generation_failed, "danger", h("/emails?status=generation_failed")],
          ]}
        />
      </div>

      {/* Recent activity */}
      <div className="mt-10 grid gap-6 xl:grid-cols-2">
        <Panel title="Recent tasks" actions={<SeeAll href={h("/tasks")} />} flush>
          {data.recentTasks.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">
              No tasks yet.{" "}
              <Link href="/tasks/new" className="font-medium text-brand hover:underline">
                Create one
              </Link>
            </p>
          ) : (
            <ul className="divide-y">
              {data.recentTasks.map((t) => (
                <li key={t.id} className="flex items-center gap-4 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {t.category} <span className="font-normal text-muted-foreground">in</span> {t.location}
                    </p>
                    <p className="tabular text-xs text-muted-foreground">
                      {t.leads_saved} / {t.candidates} leads · {timeAgo(t.created_at)}
                    </p>
                  </div>
                  <TaskStatus status={t.status} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Recent emails" actions={<SeeAll href={h("/emails")} />} flush>
          {data.recentEmails.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">No emails written yet.</p>
          ) : (
            <ul className="divide-y">
              {data.recentEmails.map((e) => (
                <li key={e.id} className="flex items-center gap-4 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{e.subject || e.websites?.name || e.email_address}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {e.email_address} · <Time value={e.sent_at ?? e.created_at} />
                    </p>
                  </div>
                  <EmailStatus status={e.status} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

function Stat({
  icon: Icon,
  tone,
  label,
  value,
  today,
  note,
  href,
}: {
  icon: LucideIcon;
  tone: Tone;
  label: string;
  value: number;
  today: number;
  note?: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-xl border bg-card p-5 shadow-card transition-all hover:-translate-y-px hover:shadow-card-hover"
    >
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-muted-foreground">{label}</span>
        <span className={`flex size-9 items-center justify-center rounded-lg ring-1 ring-inset ${toneSoft(tone)}`}>
          <Icon className="size-[18px]" />
        </span>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="tabular text-3xl font-semibold tracking-tight">{num(value)}</span>
        {today > 0 && (
          <span className="tabular rounded-md bg-success-soft px-1.5 py-0.5 text-xs font-medium text-success">
            +{num(today)} today
          </span>
        )}
      </div>
      <p className="mt-1 h-4 text-xs text-muted-foreground">{note ?? (today === 0 ? "Nothing new today" : "")}</p>
    </Link>
  );
}

function Funnel({ steps }: { steps: { label: string; value: number; href: string }[] }) {
  const top = Math.max(steps[0]?.value ?? 0, 1);
  return (
    <ol className="space-y-3.5">
      {steps.map((s, i) => {
        const prev = i > 0 ? steps[i - 1].value : null;
        return (
          <li key={s.label}>
            <Link href={s.href} className="group grid grid-cols-[110px_1fr_110px] items-center gap-4">
              <span className="text-[13px] font-medium text-secondary-foreground group-hover:text-foreground">{s.label}</span>
              <div className="h-7 overflow-hidden rounded-md bg-muted/70">
                <div
                  className="h-full rounded-md bg-gradient-to-r from-indigo-500 to-violet-500 transition-all group-hover:brightness-110"
                  style={{ width: `${Math.max(pct(s.value, top), s.value ? 4 : 0)}%` }}
                />
              </div>
              <span className="tabular text-right text-sm">
                <span className="font-semibold">{num(s.value)}</span>
                {prev !== null && (
                  <span className="ml-1.5 text-xs text-muted-foreground">{prev ? `${pct(s.value, prev)}%` : "—"}</span>
                )}
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

function Rate({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="tabular mt-0.5 text-lg font-semibold tracking-tight">{value}%</dd>
    </div>
  );
}

function Queue({ label, pool, value, href }: { label: string; pool: string; value: number; href: string }) {
  return (
    <li>
      <Link href={href} className="flex items-center justify-between gap-3 px-5 py-3 transition-colors hover:bg-subtle">
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] text-foreground">{label}</span>
          <span className="text-xs text-muted-foreground">{pool}</span>
        </span>
        {value > 0 ? (
          <span className="tabular rounded-full bg-warning-soft px-2 py-0.5 text-xs font-semibold text-warning ring-1 ring-warning-ring ring-inset">
            {num(value)}
          </span>
        ) : (
          <span className="tabular text-xs text-muted-foreground/70">0</span>
        )}
      </Link>
    </li>
  );
}

function TableCard({
  icon: Icon,
  title,
  href,
  total,
  latest,
  parts,
}: {
  icon: LucideIcon;
  title: string;
  href: string;
  total: number;
  latest: string | null;
  parts: [string, number, Tone, string][];
}) {
  return (
    <div className="flex flex-col rounded-xl border bg-card p-5 shadow-card">
      <Link href={href} className="group flex items-center justify-between">
        <span className="flex items-center gap-2.5 text-[13.5px] font-semibold">
          <span className={`flex size-7 items-center justify-center rounded-md ring-1 ring-inset ${toneSoft("brand")}`}>
            <Icon className="size-4" />
          </span>
          {title}
        </span>
        <ArrowUpRight className="size-4 text-muted-foreground/60 transition-colors group-hover:text-brand" />
      </Link>
      <p className="tabular mt-3 text-2xl font-semibold tracking-tight">{num(total)}</p>
      <div className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-muted">
        {parts.map(([label, value, tone]) =>
          value > 0 ? <div key={label} className={toneBg(tone)} style={{ width: `${pct(value, total)}%` }} /> : null,
        )}
      </div>
      <ul className="mt-3 flex-1 space-y-1.5">
        {parts.map(([label, value, tone, link]) => (
          <li key={label}>
            <Link href={link} className="flex items-center justify-between text-[13px] text-muted-foreground hover:text-foreground">
              <span className="flex items-center gap-2">
                <span className={`size-1.5 rounded-full ${toneBg(tone)}`} />
                {label}
              </span>
              <span className="tabular font-medium text-secondary-foreground">{num(value)}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
        {latest ? `Last row ${timeAgo(latest)}` : "Empty"}
      </p>
    </div>
  );
}

function SeeAll({ href }: { href: string }) {
  return (
    <Link href={href} className="text-[13px] font-medium text-brand hover:underline">
      View all
    </Link>
  );
}

