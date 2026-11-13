import Link from "@/components/link";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { num } from "@/lib/format";
import { DateFilter } from "./date-filter";

export type Chip = { value: string; label: string; count?: number };

export function href(base: string, params: Record<string, string | number | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}

/** Turn a submitted GET form into an in-app navigation to `base?field=value…` (empty fields dropped). */
export function navigateForm(e: React.FormEvent<HTMLFormElement>, base: string, navigate: (to: string) => void) {
  e.preventDefault();
  const params: Record<string, string> = {};
  for (const [k, v] of new FormData(e.currentTarget)) if (typeof v === "string") params[k] = v;
  navigate(href(base, params));
}

/** Status chips (links) on the left, a search box on the right. */
export function FilterBar({
  base,
  param = "status",
  chips,
  active,
  q,
  placeholder,
  allCount,
  from,
  to,
}: {
  base: string;
  param?: string;
  chips: Chip[];
  active?: string;
  q?: string;
  placeholder: string;
  allCount?: number;
  from?: string;
  to?: string;
}) {
  const navigate = useNavigate();
  const chip = (value: string | undefined, label: string, count?: number) => {
    const isActive = (active ?? "") === (value ?? "");
    return (
      <Link
        key={value ?? "all"}
        href={href(base, { [param]: value, q, from, to })}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors",
          isActive
            ? "bg-card text-foreground shadow-card ring-1 ring-border"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        {label}
        {count !== undefined && (
          <span className={cn("tabular text-xs", isActive ? "text-muted-foreground" : "text-muted-foreground/70")}>
            {num(count)}
          </span>
        )}
      </Link>
    );
  };

  return (
    <>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <nav className="flex flex-wrap items-center gap-0.5 rounded-xl bg-muted/70 p-1">
        {chip(undefined, "All", allCount)}
        {chips.map((c) => chip(c.value, c.label, c.count))}
      </nav>
      <form onSubmit={(e) => navigateForm(e, base, navigate)} className="relative w-full sm:w-72">
        {active && <input type="hidden" name={param} value={active} />}
        {from && <input type="hidden" name="from" value={from} />}
        {to && <input type="hidden" name="to" value={to} />}
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          id="search"
          name="q"
          defaultValue={q}
          placeholder={placeholder}
          className="h-9 w-full rounded-lg border border-input bg-card pr-10 pl-9 text-sm shadow-card outline-none placeholder:text-muted-foreground/80 focus:border-ring focus:ring-3 focus:ring-ring/25"
        />
        <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded border bg-muted px-1.5 text-[11px] text-muted-foreground">
          /
        </kbd>
      </form>
    </div>
    <DateFilter base={base} from={from} to={to} params={{ [param]: active, q }} />
    </>
  );
}
