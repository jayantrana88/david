import { useActionState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/types";
import { unlockAction } from "@/lib/actions";

export default function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(async (prev, form) => {
    const result = await unlockAction(prev, form);
    if (result?.ok) onUnlocked();
    return result;
  }, null);
  return (
    <main className="flex min-h-svh items-center justify-center px-5">
      <form
        action={action}
        className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-6 shadow-card"
      >
        <div className="flex items-center gap-2.5">
          <Lock className="size-4 text-muted-foreground" />
          <h1 className="text-sm font-semibold">Enter the dashboard password</h1>
        </div>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          className="input"
          aria-invalid={state?.ok === false}
        />
        {state?.ok === false && <p className="text-[13px] text-danger">{state.message}</p>}
        <Button type="submit" className="h-9 w-full" disabled={pending}>
          {pending ? "Checking…" : "Unlock"}
        </Button>
      </form>
    </main>
  );
}
