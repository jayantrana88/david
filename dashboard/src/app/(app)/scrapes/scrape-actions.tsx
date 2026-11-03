"use client";

import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/confirm-action";
import { verdictTone } from "@/components/status-badge";
import { cn } from "@/lib/utils";
import { deleteScrapeAction, setVerdictAction } from "./actions";

const OPTIONS: { value: boolean | null; effect: string }[] = [
  { value: true, effect: "The internal pool will read this lead's pages, then the email pool will write to it." },
  {
    value: false,
    effect:
      "No pages will be read for this lead. If its pages were already read, the email pool can still write to it: delete its pages too to stop that.",
  },
  { value: null, effect: "The AI judges this lead again from the saved summary (the homepage isn't read again)." },
];

/** Override the AI's verdict, in the expanded row. */
export function VerdictControl({ id, current, name }: { id: string; current: boolean | null; name: string }) {
  return (
    <div>
      <p className="mb-2 text-[13px] font-medium text-secondary-foreground">Override verdict</p>
      <div className="inline-flex rounded-lg bg-muted/70 p-1">
        {OPTIONS.map((o) => {
          const [, label] = verdictTone(o.value);
          const active = o.value === current;
          return active ? (
            <span
              key={label}
              className="inline-flex h-7 items-center rounded-md bg-card px-3 text-[13px] font-medium shadow-card ring-1 ring-border"
            >
              {label}
            </span>
          ) : (
            <ConfirmAction
              key={label}
              action={() => setVerdictAction(id, o.value)}
              trigger={
                <button className={cn("inline-flex h-7 items-center rounded-md px-3 text-[13px] font-medium text-muted-foreground hover:text-foreground")}>
                  {label}
                </button>
              }
              title={`Mark ${name} as “${label}”?`}
              description={o.effect}
              confirmLabel={`Set to ${label}`}
            />
          );
        })}
      </div>
    </div>
  );
}

export function RescrapeButton({ id, name }: { id: string; name: string }) {
  return (
    <ConfirmAction
      action={() => deleteScrapeAction(id)}
      trigger={
        <Button variant="ghost" size="icon-sm" aria-label="Scrape again" title="Scrape again" className="text-muted-foreground hover:text-foreground">
          <RotateCcw className="size-4" />
        </Button>
      }
      title={`Scrape ${name} again?`}
      description="This scrape is deleted, so the scrape pool reads the homepage again and asks the AI for a new verdict. A scrape that already has pages can't be deleted: re-read or delete its pages first."
      confirmLabel="Delete scrape"
      destructive
    />
  );
}
