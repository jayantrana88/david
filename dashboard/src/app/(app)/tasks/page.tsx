import type { Metadata } from "next";
import Link from "next/link";
import { ListChecks, Plus } from "lucide-react";
import { listTasks } from "@/lib/data/tasks";
import { count } from "@/lib/data/common";
import { TASK_STATUSES, type TaskStatus as Status } from "@/lib/types";
import { num, pct } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { FilterBar } from "@/components/filter-bar";
import { Pagination } from "@/components/pagination";
import { DataTable, ExpandableRow, Td, Th } from "@/components/data-table";
import { TASK_TONE, TaskStatus } from "@/components/status-badge";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Dash, Time } from "@/components/time";
import { AutoRefresh } from "@/components/auto-refresh";
import { buttonVariants } from "@/components/ui/button";
import { RepeatToggle, TaskActions } from "./task-actions";

export const metadata: Metadata = { title: "Tasks" };

export default async function TasksPage(props: PageProps<"/tasks">) {
  const sp = await props.searchParams;
  const status = TASK_STATUSES.includes(sp.status as Status) ? (sp.status as Status) : undefined;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const page = Math.max(1, Number(sp.page) || 1);

  let result, counts: number[];
  try {
    [result, counts] = await Promise.all([
      listTasks({ status, q, page }),
      Promise.all(TASK_STATUSES.map((s) => count("tasks", (qb) => qb.eq("status", s)))),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Tasks" />
        <ErrorState message={(e as Error).message} />
      </>
    );
  }
  const { rows, total } = result;
  const running = counts[TASK_STATUSES.indexOf("running")] > 0;

  return (
    <>
      <AutoRefresh active={running} />
      <PageHeader
        title="Tasks"
        description="The daemon's sourcing queue. Pending tasks run one at a time, oldest first; a failed task stays failed until you re-run it, unless it repeats daily."
        actions={
          <Link href="/tasks/new" className={buttonVariants({ className: "h-9 gap-1.5 px-3.5" })}>
            <Plus className="size-4" /> New task
          </Link>
        }
      />
      <FilterBar
        base="/tasks"
        chips={TASK_STATUSES.map((s, i) => ({ value: s, label: TASK_TONE[s][1], count: counts[i] }))}
        allCount={counts.reduce((a, b) => a + b, 0)}
        active={status}
        q={q}
        placeholder="Search category or location"
      />
      <DataTable
        head={
          <>
            <Th className="w-8" />
            <Th>Search</Th>
            <Th>Status</Th>
            <Th>Progress</Th>
            <Th>Max size</Th>
            <Th>Daily</Th>
            <Th>Created</Th>
            <Th>Finished</Th>
            <Th className="text-right">Actions</Th>
          </>
        }
        footer={<Pagination base="/tasks" page={page} total={total} params={{ status, q }} />}
      >
        {rows.length === 0 ? (
          <tr>
            <td colSpan={9}>
              <EmptyState
                icon={ListChecks}
                title={q || status ? "No matching tasks" : "No tasks yet"}
                description={q || status ? "Try another filter or search." : "Create a task to start sourcing leads."}
                action={
                  !q && !status ? (
                    <Link href="/tasks/new" className={buttonVariants({ className: "h-9 gap-1.5 px-3.5" })}>
                      <Plus className="size-4" /> New task
                    </Link>
                  ) : undefined
                }
              />
            </td>
          </tr>
        ) : (
          rows.map((t) => (
            <ExpandableRow
              key={t.id}
              colSpan={8}
              cells={
                <>
                  <Td>
                    <p className="font-medium text-foreground">{t.category}</p>
                    <p className="text-[13px] text-muted-foreground">{t.location}</p>
                  </Td>
                  <Td>
                    <TaskStatus status={t.status} />
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full ${t.status === "failed" ? "bg-danger" : "bg-brand"}`}
                          style={{ width: `${pct(t.leads_saved, t.candidates)}%` }}
                        />
                      </div>
                      <span className="tabular text-[13px] text-secondary-foreground">
                        {num(t.leads_saved)}/{num(t.candidates)}
                      </span>
                    </div>
                  </Td>
                  <Td className="tabular text-secondary-foreground">≤ {num(t.max_employees)}</Td>
                  <Td>
                    <RepeatToggle task={t} />
                  </Td>
                  <Td>
                    <Time value={t.created_at} />
                  </Td>
                  <Td>
                    <Time value={t.finished_at} />
                  </Td>
                  <Td className="text-right">
                    <TaskActions task={t} />
                  </Td>
                </>
              }
              detail={
                <dl className="grid gap-x-8 gap-y-3 text-[13px] sm:grid-cols-4">
                  <Detail label="Task">#{t.id}</Detail>
                  <Detail label="Source">{t.source}</Detail>
                  <Detail label="Role">{t.target_role || "From profile"}</Detail>
                  <Detail label="Looking for">{t.opportunity_type || "From profile"}</Detail>
                  <Detail label="Metro radius">{t.metro_radius_km === null ? "30 km (default)" : `${t.metro_radius_km} km`}</Detail>
                  <Detail label="Started">
                    <Time value={t.started_at} />
                  </Detail>
                  <Detail label="Finished">
                    <Time value={t.finished_at} />
                  </Detail>
                  <div className="sm:col-span-4">
                    <dt className="text-muted-foreground">Error</dt>
                    <dd className={`mt-0.5 ${t.error ? "text-danger" : ""}`}>{t.error || <Dash />}</dd>
                  </div>
                </dl>
              }
            />
          ))
        )}
      </DataTable>
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium text-foreground">{children}</dd>
    </div>
  );
}
