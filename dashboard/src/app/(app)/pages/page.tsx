import type { Metadata } from "next";
import { ExternalLink, FileText } from "lucide-react";
import { listPages, type PageFilter } from "@/lib/data/leads";
import { count, inRange, parseRange } from "@/lib/data/common";
import { prettyUrl } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { FilterBar } from "@/components/filter-bar";
import { Pagination } from "@/components/pagination";
import { DataTable, ExpandableRow, Td, Th } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Dash, Time } from "@/components/time";
import { PageContent, RereadButton } from "./page-parts";

export const metadata: Metadata = { title: "Pages" };

const FILTERS: PageFilter[] = ["read", "failed"];

export default async function PagesPage(props: PageProps<"/pages">) {
  const sp = await props.searchParams;
  const content = FILTERS.includes(sp.content as PageFilter) ? (sp.content as PageFilter) : undefined;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const range = parseRange(sp);
  const dated = Boolean(range.from || range.to);

  let result, total: number, failed: number;
  try {
    [result, total, failed] = await Promise.all([
      listPages({ filter: content, q, page, range }),
      count("website_pages", (qb) => inRange(qb, range)),
      count("website_pages", (qb) => inRange(qb.is("content_json", null), range)),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Pages" />
        <ErrorState message={(e as Error).message} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Pages"
        description="Internal pages (about, services, pricing…) read for each qualified lead. The email is written from these."
      />
      <FilterBar
        base="/pages"
        param="content"
        chips={[
          { value: "read", label: "Read", count: total - failed },
          { value: "failed", label: "Failed read", count: failed },
        ]}
        allCount={total}
        active={content}
        q={q}
        from={range.from}
        to={range.to}
        placeholder="Search page name or URL"
      />
      <DataTable
        head={
          <>
            <Th className="w-8" />
            <Th>Website</Th>
            <Th>Page</Th>
            <Th>Content</Th>
            <Th>Read</Th>
            <Th className="text-right">Actions</Th>
          </>
        }
        footer={<Pagination base="/pages" page={page} total={result.total} params={{ content, q, from: range.from, to: range.to }} />}
      >
        {result.rows.length === 0 ? (
          <tr>
            <td colSpan={6}>
              <EmptyState
                icon={FileText}
                title={q || content || dated ? "No matching pages" : "No pages read yet"}
                description={q || content || dated ? "Try another filter or search." : "Pages are read for every qualified lead."}
              />
            </td>
          </tr>
        ) : (
          result.rows.map((p) => {
            const site = p.website_scrapes?.websites;
            return (
              <ExpandableRow
                key={p.id}
                colSpan={5}
                cells={
                  <>
                    <Td className="max-w-56">
                      <p className="truncate font-medium text-foreground">{site?.name ?? <Dash />}</p>
                    </Td>
                    <Td className="max-w-72">
                      <p className="truncate text-foreground">{p.page_name}</p>
                      {p.page_url && (
                        <a
                          href={p.page_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex max-w-full items-center gap-1 text-[13px] text-muted-foreground hover:text-brand"
                        >
                          <span className="truncate">{prettyUrl(p.page_url)}</span>
                          <ExternalLink className="size-3 shrink-0" />
                        </a>
                      )}
                    </Td>
                    <Td>
                      {p.has_content ? (
                        <StatusBadge tone="success">Read</StatusBadge>
                      ) : (
                        <StatusBadge tone="warning">Failed, will retry</StatusBadge>
                      )}
                    </Td>
                    <Td>
                      <Time value={p.created_at} />
                    </Td>
                    <Td className="text-right">
                      <RereadButton scrapeId={p.scrape_id} name={site?.name ?? "this lead"} />
                    </Td>
                  </>
                }
                detail={<PageContent id={p.id} />}
              />
            );
          })
        )}
      </DataTable>
    </>
  );
}
