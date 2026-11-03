import type { Metadata } from "next";
import { ExternalLink, Globe } from "lucide-react";
import { listWebsites, type WebsiteFilter } from "@/lib/data/leads";
import { count, inRange, parseRange } from "@/lib/data/common";
import { prettyUrl } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { FilterBar } from "@/components/filter-bar";
import { Pagination } from "@/components/pagination";
import { DataTable, ExpandableRow, Td, Th } from "@/components/data-table";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Dash, Time } from "@/components/time";
import { WebsiteActions } from "./website-actions";
import { WebsiteProgress } from "./progress";

export const metadata: Metadata = { title: "Websites" };

const FILTERS: Record<string, WebsiteFilter> = { with: "with_email", without: "no_email" };

export default async function WebsitesPage(props: PageProps<"/websites">) {
  const sp = await props.searchParams;
  const emailParam = typeof sp.email === "string" && sp.email in FILTERS ? sp.email : undefined;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const range = parseRange(sp);
  const dated = Boolean(range.from || range.to);

  let result, total: number, withEmail: number;
  try {
    [result, total, withEmail] = await Promise.all([
      listWebsites({ filter: emailParam ? FILTERS[emailParam] : undefined, q, page, range }),
      count("websites", (qb) => inRange(qb, range)),
      count("websites", (qb) => inRange(qb.not("email", "is", null), range)),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Websites" />
        <ErrorState message={(e as Error).message} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Websites"
        description="Every company the sourcing pool found. A new row is picked up by the scrape pool on its own (the fit check); the email pool needs an address."
      />
      <FilterBar
        base="/websites"
        param="email"
        chips={[
          { value: "with", label: "Has email", count: withEmail },
          { value: "without", label: "No email", count: total - withEmail },
        ]}
        allCount={total}
        active={emailParam}
        q={q}
        from={range.from}
        to={range.to}
        placeholder="Search name, URL, email…"
      />
      <DataTable
        head={
          <>
            <Th className="w-8" />
            <Th>Lead</Th>
            <Th>Email</Th>
            <Th>Category</Th>
            <Th>Location</Th>
            <Th>Added</Th>
            <Th className="text-right">Actions</Th>
          </>
        }
        footer={<Pagination base="/websites" page={page} total={result.total} params={{ email: emailParam, q, from: range.from, to: range.to }} />}
      >
        {result.rows.length === 0 ? (
          <tr>
            <td colSpan={7}>
              <EmptyState
                icon={Globe}
                title={q || emailParam || dated ? "No matching websites" : "No leads yet"}
                description={q || emailParam || dated ? "Try another filter or search." : "Leads appear here as tasks run."}
              />
            </td>
          </tr>
        ) : (
          result.rows.map((w) => (
            <ExpandableRow
              key={w.id}
              colSpan={6}
              cells={
                <>
                  <Td className="max-w-72">
                    <p className="truncate font-medium text-foreground">{w.name}</p>
                    <a
                      href={w.website_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex max-w-full items-center gap-1 text-[13px] text-muted-foreground hover:text-brand"
                    >
                      <span className="truncate">{prettyUrl(w.website_url)}</span>
                      <ExternalLink className="size-3 shrink-0" />
                    </a>
                  </Td>
                  <Td className="max-w-60">
                    {w.email ? <span className="block truncate text-secondary-foreground" title={w.email}>{w.email}</span> : <Dash />}
                  </Td>
                  <Td className="text-secondary-foreground">{w.category || <Dash />}</Td>
                  <Td className="max-w-48 truncate text-secondary-foreground">{w.location || <Dash />}</Td>
                  <Td>
                    <Time value={w.created_at} />
                  </Td>
                  <Td className="text-right">
                    <WebsiteActions website={w} />
                  </Td>
                </>
              }
              detail={
                <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px]">
                    <Item label="Phone">{w.phone_number || <Dash />}</Item>
                    <Item label="Owner">{w.owner || <Dash />}</Item>
                    <Item label="Source">{w.source || <Dash />}</Item>
                    <Item label="Company size">{w.employee_size || <Dash />}</Item>
                    <Item label="Industry">{w.industry || <Dash />}</Item>
                    <Item label="LinkedIn">
                      {w.linkedin_url ? (
                        <a href={w.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                          Company page
                        </a>
                      ) : (
                        <Dash />
                      )}
                    </Item>
                    <Item label="Lead ID">
                      <span className="font-mono text-xs">{w.id.slice(0, 8)}</span>
                    </Item>
                  </dl>
                  <WebsiteProgress id={w.id} />
                </div>
              }
            />
          ))
        )}
      </DataTable>
    </>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-foreground">{children}</dd>
    </div>
  );
}
