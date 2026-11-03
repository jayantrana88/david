"use client";

import { useActionState, useState } from "react";
import { toast } from "sonner";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/confirm-action";
import { StatusBadge } from "@/components/status-badge";
import type { ActionResult } from "@/lib/types";
import { lockNowAction, removeLockAction, setLockAction } from "./actions";

export function LockPanel({ locked }: { locked: boolean }) {
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState<ActionResult, FormData>(async (prev, form) => {
    const result = await setLockAction(prev, form);
    if (result?.ok) setEditing(false);
    else toast.error(result?.message ?? "Something went wrong");
    return result;
  }, null);

  return (
    <section className="rounded-xl border bg-card shadow-card">
      <header className="border-b px-6 py-5">
        <h2 className="text-sm font-semibold">Dashboard password</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Optional. Asked once per browser every 30 days.
        </p>
      </header>
      <div className="px-6 py-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-subtle">
            <Lock className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Password</p>
            <p className="text-[13px] text-muted-foreground">At least 6 characters.</p>
          </div>
          <StatusBadge tone={locked ? "success" : "neutral"}>{locked ? "On" : "Off"}</StatusBadge>
          {!editing && (
            <div className="flex gap-1.5">
              <Button variant="outline" className="h-8 px-3" onClick={() => setEditing(true)}>
                {locked ? "Change" : "Set a password"}
              </Button>
              {locked && (
                <>
                  <ConfirmAction
                    action={lockNowAction}
                    trigger={
                      <Button variant="ghost" className="h-8 px-3 text-muted-foreground">
                        Lock now
                      </Button>
                    }
                    title="Lock the dashboard now?"
                    description="This browser is signed out and asks for the password again."
                    confirmLabel="Lock now"
                  />
                  <ConfirmAction
                    action={removeLockAction}
                    trigger={
                      <Button variant="ghost" className="h-8 px-3 text-muted-foreground hover:text-danger">
                        Remove
                      </Button>
                    }
                    title="Remove the password?"
                    description="Anyone who has the dashboard's address can open it."
                    confirmLabel="Remove password"
                    destructive
                  />
                </>
              )}
            </div>
          )}
        </div>
        {editing && (
          <form action={action} className="mt-3 flex flex-wrap gap-2 pl-13">
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              autoFocus
              placeholder="New password"
              className="input h-9 min-w-64 flex-1"
              aria-invalid={!!state?.fieldErrors?.password}
            />
            <Button type="button" variant="outline" className="h-9 px-3.5" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" className="h-9 px-4" disabled={pending}>
              {pending ? "Saving…" : "Save password"}
            </Button>
          </form>
        )}
      </div>
    </section>
  );
}
