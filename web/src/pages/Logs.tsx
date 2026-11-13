import { ScrollText } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { ErrorState, EmptyState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/list-skeleton";
import { DataTable, Td, Th } from "@/components/data-table";
import { StatusBadge, type Tone } from "@/components/status-badge";
import { Time } from "@/components/time";
import { cn } from "@/lib/utils";

type Line = { at: string; stage: string; level: string; message: string };
const STAGES = ["profile", "sourcing", "scrape", "internal", "email", "tick"];
const LEVEL: Record<string, Tone> = { warn: "warning", warning: "warning", error: "danger" };

/** The Worker's last 300 log lines (kept 3 days). */
export default function Logs() {
  const [sp, setSp] = useSearchParams();
  const stage = sp.get("stage") ?? "";
  const { data, error } = useApi<{ rows: Line[] }>(`/api/logs${stage ? `?stage=${stage}` : ""}`, { every: 10 });
  if (error && !data) {
    return (
      <>
        <PageHeader title="Logs" />
        <ErrorState message={error} />
      </>
    );
  }
  if (!data) return <ListSkeleton title="Logs" />;
  const chip = (value: string, label: string) => (
    <button
      key={value}
      onClick={() => setSp(value ? { stage: value } : {})}
      className={cn(
        "inline-flex h-8 items-center rounded-lg px-3 text-[13px] font-medium transition-colors",
        stage === value ? "bg-card text-foreground shadow-card ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <>
      <PageHeader
        title="Logs"
        description="The last 300 lines, kept for 3 days. Every line also goes to the Worker's logs in the Cloudflare dashboard."
      />
      <nav className="mb-3 inline-flex flex-wrap items-center gap-0.5 rounded-xl bg-muted/70 p-1">
        {chip("", "All")}
        {STAGES.map((s) => chip(s, s))}
      </nav>
      <DataTable
        head={
          <>
            <Th>When</Th>
            <Th>Stage</Th>
            <Th>Level</Th>
            <Th>Message</Th>
          </>
        }
      >
        {data.rows.length === 0 ? (
          <tr>
            <td colSpan={4}>
              <EmptyState icon={ScrollText} title="Nothing logged yet" description="Lines appear here as the stages run." />
            </td>
          </tr>
        ) : (
          data.rows.map((l, i) => (
            <tr key={i} className="align-top">
              <Td>
                <Time value={l.at} />
              </Td>
              <Td className="text-secondary-foreground">{l.stage}</Td>
              <Td>{l.level !== "info" && <StatusBadge tone={LEVEL[l.level] ?? "neutral"}>{l.level}</StatusBadge>}</Td>
              <Td className="max-w-2xl font-mono text-xs break-words whitespace-pre-wrap text-secondary-foreground">{l.message}</Td>
            </tr>
          ))
        )}
      </DataTable>
    </>
  );
}
