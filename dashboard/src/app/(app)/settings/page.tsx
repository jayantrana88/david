import type { Metadata } from "next";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { getSecretStatus, getSettings, type AppSettings } from "@/lib/data/settings";
import { timeAgo } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { SettingsForm } from "./settings-form";
import { SecretsPanel } from "./secrets-panel";
import { LockPanel } from "./lock-panel";
import { lockHash } from "@/lib/lock";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  let settings, secrets;
  try {
    [settings, secrets] = await Promise.all([getSettings(), getSecretStatus()]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Settings" />
        <ErrorState message={(e as Error).message} />
      </>
    );
  }

  if (!settings || !secrets) {
    return (
      <>
        <PageHeader title="Settings" />
        <ErrorState message="The settings could not be read from the database." />
      </>
    );
  }

  const { version, updated_at, applied_version, applied_at, applied_mode, apply_error, ...fields } = settings;
  return (
    <>
      <PageHeader
        title="Settings"
        description="Empty fields use the defaults."
      />
      <DaemonStatus settings={settings} />
      <div className="mt-6 space-y-6">
        <SettingsForm initial={fields} />
        <SecretsPanel secrets={secrets} />
        <LockPanel locked={lockHash() !== null} />
      </div>
      <p className="mt-6 text-xs text-muted-foreground">
        Settings version {version} · last changed {timeAgo(updated_at)}
        {applied_version != null && ` · daemon loaded version ${applied_version} ${timeAgo(applied_at)}`}
        {applied_version == null && apply_error == null && " · the daemon hasn't reported yet"}
      </p>
    </>
  );
}

function DaemonStatus({ settings: s }: { settings: AppSettings }) {
  if (s.apply_error) {
    return (
      <Banner tone="danger" icon={AlertTriangle} title="The daemon refused to start with these settings">
        <p className="font-mono text-xs break-words">{s.apply_error}</p>
        <p className="mt-1.5">Fix the value below, save, and start the daemon again. ({timeAgo(s.applied_at)})</p>
      </Banner>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card px-5 py-3.5 shadow-card">
      <CheckCircle2 className="size-4 text-success" />
      <p className="text-[13px] text-secondary-foreground">
        {s.applied_version != null ? "The daemon is running with the latest settings." : "No daemon has loaded these settings yet."}
      </p>
      <span className="ml-auto">
        <StatusBadge tone={s.applied_version != null ? "success" : "neutral"}>
          {s.applied_version != null ? "Running" : "Not started"}
        </StatusBadge>
      </span>
    </div>
  );
}

function Banner({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: "warning" | "danger" | "info";
  icon: typeof RefreshCw;
  title: string;
  children: React.ReactNode;
}) {
  const styles = {
    warning: "border-warning-ring bg-warning-soft text-warning",
    danger: "border-danger-ring bg-danger-soft text-danger",
    info: "border-info-ring bg-info-soft text-info",
  }[tone];
  return (
    <div className={`flex gap-3 rounded-xl border px-5 py-4 ${styles}`}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 text-[13px] leading-relaxed">
        <p className="font-semibold">{title}</p>
        <div className="mt-0.5 text-foreground/80">{children}</div>
      </div>
    </div>
  );
}
