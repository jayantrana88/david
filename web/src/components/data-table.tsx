
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** The table frame: a card with a sticky, quiet header. */
export function DataTable({ head, children, footer }: { head: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-card">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b bg-subtle text-left">{head}</tr>
          </thead>
          <tbody className="divide-y">{children}</tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}

export function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={cn("h-10 px-4 text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-5 last:pr-5", className)}>
      {children}
    </th>
  );
}

export function Td({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <td className={cn("px-4 py-3 align-middle first:pl-5 last:pr-5", className)}>{children}</td>;
}

/**
 * A row that opens a detail panel beneath it. `cells` and `detail` are rendered on the server; this only
 * toggles them. `detail` may be a client component that loads its data when first shown.
 */
export function ExpandableRow({
  cells,
  detail,
  colSpan,
}: {
  cells: React.ReactNode;
  detail: React.ReactNode;
  colSpan: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        className={cn("group cursor-pointer transition-colors hover:bg-subtle", open && "bg-subtle")}
        onClick={(e) => {
          // Buttons, links and menus inside the row keep their own click; so do dialogs opened from the row
          // (they're portalled elsewhere in the DOM, but React still bubbles their clicks here).
          const target = e.target as HTMLElement;
          if (!e.currentTarget.contains(target)) return;
          if (target.closest("a, button, [role=menu], [data-no-toggle]")) return;
          setOpen((o) => !o);
        }}
      >
        <td className="w-8 py-3 pl-4 align-middle">
          <ChevronRight
            className={cn("size-4 text-muted-foreground/70 transition-transform duration-200", open && "rotate-90")}
          />
        </td>
        {cells}
      </tr>
      {open && (
        <tr className="bg-subtle">
          <td colSpan={colSpan + 1} className="px-5 pt-1 pb-5">
            <div className="animate-in fade-in-0 slide-in-from-top-1 rounded-lg border bg-card p-4 duration-200">{detail}</div>
          </td>
        </tr>
      )}
    </>
  );
}
