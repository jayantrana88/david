import type { Metadata } from "next";
import { ExternalLink, ScanSearch } from "lucide-react";
import { listScrapes, type ScrapeFilter } from "@/lib/data/leads";
import { count, inRange, parseRange } from "@/lib/data/common";
import { plainText, prettyUrl } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { FilterBar } from "@/components/filter-bar";
import { Pagination } from "@/components/pagination";
import { DataTable, ExpandableRow, Td, Th } from "@/components/data-table";
import { Verdict } from "@/components/status-badge";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Dash, Time } from "@/components/time";
import { RescrapeButton, VerdictControl } from "./scrape-actions";

export const metadata: Metadata = { title: "Scrapes" };

const FILTERS: ScrapeFilter[] = ["qualified", "rejected", "pending"];

export default async function ScrapesPage(props: PageProps<"/scrapes">) {
  const sp = await props.searchParams;
  const verdict = FILTERS.includes(sp.verdict as ScrapeFilter) ? (sp.verdict as ScrapeFilter) : undefined;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const range = parseRange(sp);
  const dated = Boolean(range.from || range.to);

  let result, counts: number[];
  try {
    [result, counts] = await Promise.all([
      listScrapes({ filter: verdict, q, page, range }),
      Promise.all([
        count("website_scrapes", (qb) => inRange(qb.eq("is_qualified", true), range)),
        count("website_scrapes", (qb) => inRange(qb.eq("is_qualified", false), range)),
        count("website_scrapes", (qb) => inRange(qb.is("is_qualified", null), range)),
      ]),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Scrapes" />
        <ErrorState message={(e as Error).message} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Scrapes"
        description="One homepage read per website, with the AI's verdict on whether the business is a fit. Qualified leads move on to page reading."
      />
      <FilterBar
        base="/scrapes"
        param="verdict"
        chips={[
          { value: "qualified", label: "Qualified", count: counts[0] },
          { value: "rejected", label: "Not a fit", count: counts[1] },
          { value: "pending", label: "Awaiting AI", count: counts[2] },
        ]}
        allCount={counts[0] + counts[1] + counts[2]}
        active={verdict}
        q={q}
        from={range.from}
        to={range.to}
        placeholder="Search summaries"
      />
      <DataTable
        head={
          <>
            <Th className="w-8" />
            <Th>Website</Th>
            <Th>Verdict</Th>
            <Th>Summary</Th>
            <Th>Scraped</Th>
            <Th className="text-right">Actions</Th>
          </>
        }
        footer={<Pagination base="/scrapes" page={page} total={result.total} params={{ verdict, q, from: range.from, to: range.to }} />}
      >
        {result.rows.length === 0 ? (
          <tr>
            <td colSpan={6}>
              <EmptyState
                icon={ScanSearch}
                title={q || verdict || dated ? "No matching scrapes" : "Nothing scraped yet"}
                description={q || verdict || dated ? "Try another filter or search." : "The scrape pool reads each new website's homepage."}
              />
            </td>
          </tr>
        ) : (
          result.rows.map((s) => {
            const name = s.websites?.name ?? "this lead";
            return (
              <ExpandableRow
                key={s.id}
                colSpan={5}
                cells={
                  <>
                    <Td className="max-w-64">
                      <p className="truncate font-medium text-foreground">{s.websites?.name ?? <Dash />}</p>
                      {s.websites?.website_url && (
                        <a
                          href={s.websites.website_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex max-w-full items-center gap-1 text-[13px] text-muted-foreground hover:text-brand"
                        >
                          <span className="truncate">{prettyUrl(s.websites.website_url)}</span>
                          <ExternalLink className="size-3 shrink-0" />
                        </a>
                      )}
                    </Td>
                    <Td>
                      <Verdict value={s.is_qualified} />
                    </Td>
                    <Td className="max-w-md">
                      <p className="line-clamp-2 text-[13px] leading-relaxed text-secondary-foreground">{plainText(s.summary) || <Dash />}</p>
                    </Td>
                    <Td>
                      <Time value={s.created_at} />
                    </Td>
                    <Td className="text-right">
                      <RescrapeButton id={s.id} name={name} />
                    </Td>
                  </>
                }
                detail={
                  <div className="space-y-5">
                    <div>
                      <p className="mb-1.5 text-[13px] font-medium text-secondary-foreground">Summary</p>
                      <p className="max-w-3xl text-[13px] leading-relaxed whitespace-pre-line text-foreground">
                        {plainText(s.summary) || "No summary: the homepage couldn't be read."}
                      </p>
                    </div>
                    <VerdictControl id={s.id} current={s.is_qualified} name={name} />
                  </div>
                }
              />
            );
          })
        )}
      </DataTable>
    </>
  );
}
