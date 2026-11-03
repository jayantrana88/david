import type { Metadata } from "next";
import { Mail } from "lucide-react";
import { listEmails, RETRYABLE } from "@/lib/data/leads";
import { count, inRange, parseRange } from "@/lib/data/common";
import { DELIVERY_LABEL, EMAIL_STATUSES, type ColdEmail, type EmailStatus as Status } from "@/lib/types";
import { PageHeader } from "@/components/page-header";
import { FilterBar } from "@/components/filter-bar";
import { Pagination } from "@/components/pagination";
import { DataTable, ExpandableRow, Td, Th } from "@/components/data-table";
import { EMAIL_TONE, EmailStatus } from "@/components/status-badge";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Dash, Time } from "@/components/time";
import { RetryEmailButton } from "./retry-button";

export const metadata: Metadata = { title: "Cold emails" };

export default async function EmailsPage(props: PageProps<"/emails">) {
  const sp = await props.searchParams;
  const status = EMAIL_STATUSES.includes(sp.status as Status) ? (sp.status as Status) : undefined;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const range = parseRange(sp);
  const dated = Boolean(range.from || range.to);

  let result, counts: number[];
  try {
    [result, counts] = await Promise.all([
      listEmails({ filter: status, q, page, range }),
      Promise.all(EMAIL_STATUSES.map((s) => count("cold_emails", (qb) => inRange(qb.eq("status", s), range)))),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Cold emails" />
        <ErrorState message={(e as Error).message} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Cold emails"
        description="One row per company you applied to: the email the AI wrote (your resume goes with it) and whether it went out. In dry-run mode the emails are saved as drafts and nothing is sent; with Telegram delivery, “Sent” means posted to your chat for you to send."
      />
      <FilterBar
        base="/emails"
        chips={EMAIL_STATUSES.map((s, i) => ({ value: s, label: EMAIL_TONE[s][1], count: counts[i] }))}
        allCount={counts.reduce((a, b) => a + b, 0)}
        active={status}
        q={q}
        from={range.from}
        to={range.to}
        placeholder="Search recipient or subject"
      />
      <DataTable
        head={
          <>
            <Th className="w-8" />
            <Th>Lead</Th>
            <Th>Subject</Th>
            <Th>Status</Th>
            <Th>Sent</Th>
            <Th className="text-right">Actions</Th>
          </>
        }
        footer={<Pagination base="/emails" page={page} total={result.total} params={{ status, q, from: range.from, to: range.to }} />}
      >
        {result.rows.length === 0 ? (
          <tr>
            <td colSpan={6}>
              <EmptyState
                icon={Mail}
                title={q || status || dated ? "No matching emails" : "No emails yet"}
                description={q || status || dated ? "Try another filter or search." : "Emails appear once leads have their pages read."}
              />
            </td>
          </tr>
        ) : (
          result.rows.map((e) => (
            <ExpandableRow
              key={e.id}
              colSpan={5}
              cells={
                <>
                  <Td className="max-w-60">
                    <p className="truncate font-medium text-foreground">{e.websites?.name ?? <Dash />}</p>
                    <p className="truncate text-[13px] text-muted-foreground">{e.email_address}</p>
                  </Td>
                  <Td className="max-w-md">
                    <p className="truncate text-secondary-foreground">{e.subject || <Dash />}</p>
                  </Td>
                  <Td>
                    <EmailStatus status={e.status} />
                    {e.delivery && e.status !== "draft" && (
                      <p className="mt-1 text-xs text-muted-foreground">{viaLabel(e)}</p>
                    )}
                  </Td>
                  <Td>
                    <Time value={e.sent_at} />
                  </Td>
                  <Td className="text-right">
                    {RETRYABLE.includes(e.status) && <RetryEmailButton id={e.id} to={e.email_address} />}
                  </Td>
                </>
              }
              detail={
                e.body ? (
                  <article className="max-w-2xl">
                    <div className="mb-4 space-y-1 border-b pb-4 text-[13px]">
                      <p>
                        <span className="inline-block w-16 text-muted-foreground">To</span>
                        {e.email_address}
                      </p>
                      <p>
                        <span className="inline-block w-16 text-muted-foreground">Subject</span>
                        <span className="font-medium">{e.subject}</span>
                      </p>
                      <p>
                        <span className="inline-block w-16 text-muted-foreground">Resume</span>
                        {e.attachment_name || <Dash />}
                      </p>
                      {e.delivery && (
                        <p>
                          <span className="inline-block w-16 text-muted-foreground">Via</span>
                          {e.delivery === "telegram" ? "Your Telegram chat (sent by hand from there)" : DELIVERY_LABEL[e.delivery]}
                        </p>
                      )}
                      <p>
                        <span className="inline-block w-16 text-muted-foreground">Written</span>
                        <Time value={e.created_at} />
                      </p>
                    </div>
                    <p className="text-sm leading-relaxed whitespace-pre-line text-foreground">{e.body}</p>
                  </article>
                ) : (
                  <p className="text-[13px] text-muted-foreground">
                    No email body: the AI&apos;s drafts didn&apos;t pass the rule check, so nothing was written.
                  </p>
                )
              }
            />
          ))
        )}
      </DataTable>
    </>
  );
}

/** "to Telegram" / "via Gmail"; a row left "sending" by a mail provider may or may not have gone out. */
function viaLabel(e: ColdEmail): string {
  if (!e.delivery) return "";
  if (e.delivery === "telegram") return "to Telegram";
  const via = `via ${DELIVERY_LABEL[e.delivery]}`;
  return e.status === "sending" ? `${via} · check Sent folder` : via;
}
