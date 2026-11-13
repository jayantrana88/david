import { ExternalLink, ScanSearch } from "lucide-react";
import type { ListResult, Scrape } from "@/lib/types";
import { plainText, prettyUrl } from "@/lib/format";
import { useApi } from "@/lib/api";
import { qs, useListQuery } from "@/lib/search";
import { PageHeader } from "@/components/page-header";
import { FilterBar } from "@/components/filter-bar";
import { Pagination } from "@/components/pagination";
import { DataTable, ExpandableRow, Td, Th } from "@/components/data-table";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/list-skeleton";
import { Dash, Time } from "@/components/time";
import { Verdict } from "@/components/status-badge";
import { RescrapeButton, VerdictControl } from "./scrapes-parts";

export default function Scrapes() {
  const { filter: verdict, q, page, range, dated } = useListQuery("verdict");
  const { data, error } = useApi<ListResult<Scrape> & { counts: number[] }>(
    `/api/scrapes${qs({ verdict, q, page, from: range.from, to: range.to })}`,
  );
  if (error && !data) {
    return (
      <>
        <PageHeader title="Fit checks" />
        <ErrorState message={error} />
      </>
    );
  }
  if (!data) return <ListSkeleton title="Fit checks" />;
  const result = data;
  const counts = data.counts;

  return (
    <>
      <PageHeader
        title="Fit checks"
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
