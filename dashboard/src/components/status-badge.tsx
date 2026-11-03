import { cn } from "@/lib/utils";

export type Tone = "success" | "warning" | "danger" | "info" | "neutral" | "brand";

const TONES: Record<Tone, string> = {
  success: "bg-success-soft text-success ring-success-ring",
  warning: "bg-warning-soft text-warning ring-warning-ring",
  danger: "bg-danger-soft text-danger ring-danger-ring",
  info: "bg-info-soft text-info ring-info-ring",
  neutral: "bg-neutral-soft text-neutral ring-neutral-ring",
  brand: "bg-brand-soft text-brand ring-brand-ring",
};

const DOTS: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  neutral: "bg-neutral-dot",
  brand: "bg-brand",
};

export function StatusBadge({
  tone,
  children,
  pulse,
  className,
}: {
  tone: Tone;
  children: React.ReactNode;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap ring-1 ring-inset",
        TONES[tone],
        className,
      )}
    >
      <span className="relative flex size-1.5">
        {pulse && <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", DOTS[tone])} />}
        <span className={cn("relative inline-flex size-1.5 rounded-full", DOTS[tone])} />
      </span>
      {children}
    </span>
  );
}

export function toneBg(tone: Tone): string {
  return DOTS[tone];
}

/** Soft background, text and ring colour of a tone (pair with `ring-1 ring-inset`). */
export function toneSoft(tone: Tone): string {
  return TONES[tone];
}

// ── the daemon's statuses ─────────────────────────────────────────────────────

export const TASK_TONE: Record<string, [Tone, string]> = {
  pending: ["warning", "Pending"],
  running: ["info", "Running"],
  completed: ["success", "Completed"],
  failed: ["danger", "Failed"],
};

export const EMAIL_TONE: Record<string, [Tone, string]> = {
  draft: ["neutral", "Draft"],
  sending: ["info", "Sending"],
  sent: ["success", "Sent"],
  send_failed: ["warning", "Send failed"],
  rejected: ["danger", "Rejected"],
  generation_failed: ["danger", "Not written"],
};

export function verdictTone(v: boolean | null): [Tone, string] {
  if (v === true) return ["success", "Qualified"];
  if (v === false) return ["neutral", "Not a fit"];
  return ["warning", "Awaiting AI"];
}

export function TaskStatus({ status }: { status: string }) {
  const [tone, label] = TASK_TONE[status] ?? ["neutral", status];
  return (
    <StatusBadge tone={tone} pulse={status === "running"}>
      {label}
    </StatusBadge>
  );
}

export function EmailStatus({ status }: { status: string }) {
  const [tone, label] = EMAIL_TONE[status] ?? ["neutral", status];
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

export function Verdict({ value }: { value: boolean | null }) {
  const [tone, label] = verdictTone(value);
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}
