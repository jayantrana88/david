import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PAGE_SIZE } from "@/lib/data/common";
import { num } from "@/lib/format";
import { href } from "./filter-bar";

export function Pagination({
  base,
  page,
  total,
  params,
}: {
  base: string;
  page: number;
  total: number;
  params: Record<string, string | undefined>;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);
  const btn =
    "inline-flex h-8 items-center gap-1 rounded-lg border bg-card px-2.5 text-[13px] font-medium text-foreground shadow-card hover:bg-accent";
  const off = "pointer-events-none opacity-40";
  return (
    <div className="flex items-center justify-between border-t px-4 py-3 text-[13px] text-muted-foreground">
      <span className="tabular">
        {total === 0 ? "No results" : `${num(from)}–${num(to)} of ${num(total)}`}
      </span>
      <div className="flex items-center gap-2">
        <Link
          className={`${btn} ${page <= 1 ? off : ""}`}
          href={href(base, { ...params, page: page - 1 })}
          aria-disabled={page <= 1}
        >
          <ChevronLeft className="size-4" /> Previous
        </Link>
        <Link
          className={`${btn} ${page >= pages ? off : ""}`}
          href={href(base, { ...params, page: page + 1 })}
          aria-disabled={page >= pages}
        >
          Next <ChevronRight className="size-4" />
        </Link>
      </div>
    </div>
  );
}
