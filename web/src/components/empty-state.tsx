import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-brand-soft text-brand ring-1 ring-brand-ring ring-inset">
        <Icon className="size-5" />
      </div>
      <h3 className="text-[15px] font-semibold text-foreground">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-danger-ring bg-danger-soft px-5 py-4 text-sm text-danger">
      <p className="font-medium">Couldn&apos;t load this page</p>
      <p className="mt-1 opacity-90">{message}</p>
    </div>
  );
}
