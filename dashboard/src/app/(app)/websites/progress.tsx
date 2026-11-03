"use client";

import { useEffect, useState } from "react";
import { EmailStatus, Verdict } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { plainText, timeAgo } from "@/lib/format";
import { websiteProgressAction } from "./actions";

type Progress = Awaited<ReturnType<typeof websiteProgressAction>>;

/** A lead's scrape and email, loaded when its row is opened. */
export function WebsiteProgress({ id }: { id: string }) {
  const [data, setData] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    websiteProgressAction(id)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) return <p className="text-[13px] text-danger">{error}</p>;
  if (!data) return <Skeleton className="h-24 w-full" />;

  const scrape = data.scrapes[0] as
    | { is_qualified: boolean | null; summary: string | null; created_at: string; website_pages: { count: number }[] }
    | undefined;
  const email = data.emails[0] as { status: string; subject: string | null; sent_at: string | null } | undefined;
  const pages = scrape?.website_pages?.[0]?.count ?? 0;

  const steps = [
    { label: "Scraped", done: !!scrape, info: scrape ? timeAgo(scrape.created_at) : "Waiting for the scrape pool" },
    {
      label: "Verdict",
      done: scrape?.is_qualified != null,
      info: scrape ? <Verdict value={scrape.is_qualified} /> : "—",
    },
    { label: "Pages read", done: pages > 0, info: pages ? `${pages} page${pages === 1 ? "" : "s"}` : "—" },
    { label: "Email", done: email?.status === "sent", info: email ? <EmailStatus status={email.status} /> : "Not written" },
  ];

  return (
    <div>
      <p className="mb-3 text-[13px] font-medium text-secondary-foreground">Pipeline</p>
      <ol className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {steps.map((s) => (
          <li key={s.label} className="rounded-lg border px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <span className={`size-1.5 rounded-full ${s.done ? "bg-success" : "bg-neutral-ring"}`} />
              {s.label}
            </div>
            <div className="mt-1.5 text-[13px]">{s.info}</div>
          </li>
        ))}
      </ol>
      {scrape?.summary && (
        <p className="mt-3 line-clamp-3 text-[13px] leading-relaxed text-muted-foreground">{plainText(scrape.summary)}</p>
      )}
      {email?.subject && (
        <p className="mt-2 text-[13px] text-secondary-foreground">
          <span className="text-muted-foreground">Subject:</span> {email.subject}
        </p>
      )}
    </div>
  );
}
