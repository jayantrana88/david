import Link from "@/components/link";
import { useNavigate } from "react-router-dom";
import { CalendarDays, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { href, navigateForm } from "./filter-bar";

type Params = Record<string, string | number | undefined | null>;

const day = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return day(d);
};

/**
 * Date filter (UTC days, inclusive): pick one date (same day in both boxes, or just "From"/"To" alone for an open
 * range) or a range. `params` are the other filters to keep.
 */
export function DateFilter({ base, from, to, params = {} }: { base: string; from?: string; to?: string; params?: Params }) {
  const navigate = useNavigate();
  const today = day(new Date());
  const presets: [string, string, string][] = [
    ["Today", today, today],
    ["Yesterday", daysAgo(1), daysAgo(1)],
    ["Last 7 days", daysAgo(6), today],
    ["Last 30 days", daysAgo(29), today],
  ];
  const active = Boolean(from || to);
  const input =
    "h-8 rounded-lg border border-input bg-card px-2 text-[13px] shadow-card outline-none focus:border-ring focus:ring-3 focus:ring-ring/25";

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      <form onSubmit={(e) => navigateForm(e, base, navigate)} className="flex flex-wrap items-center gap-2">
        {Object.entries(params).map(([k, v]) =>
          v !== undefined && v !== null && v !== "" ? <input key={k} type="hidden" name={k} value={String(v)} /> : null,
        )}
        <CalendarDays className="size-4 text-muted-foreground" />
        <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          From
          <input type="date" name="from" defaultValue={from} max={to} className={input} />
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          To
          <input type="date" name="to" defaultValue={to} min={from} className={input} />
        </label>
        <button
          type="submit"
          className="inline-flex h-8 items-center rounded-lg border bg-card px-3 text-[13px] font-medium shadow-card hover:bg-accent"
        >
          Apply
        </button>
        {active && (
          <Link
            href={href(base, params)}
            className="inline-flex h-8 items-center gap-1 px-1.5 text-[13px] text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" /> Clear
          </Link>
        )}
      </form>
      <nav className="flex flex-wrap items-center gap-0.5">
        {presets.map(([label, f, t]) => (
          <Link
            key={label}
            href={href(base, { ...params, from: f, to: t })}
            className={cn(
              "inline-flex h-7 items-center rounded-md px-2 text-xs font-medium transition-colors",
              from === f && to === t ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
