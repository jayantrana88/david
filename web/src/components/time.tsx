import { dateTime, timeAgo } from "@/lib/format";

/** A relative time ("5m ago") with the full date on hover. */
export function Time({ value, className = "" }: { value: string | null | undefined; className?: string }) {
  if (!value) return <span className="text-muted-foreground/60">—</span>;
  return (
    <time dateTime={value} title={dateTime(value)} className={`whitespace-nowrap text-muted-foreground ${className}`}>
      {timeAgo(value)}
    </time>
  );
}

export function Dash() {
  return <span className="text-muted-foreground/60">—</span>;
}
