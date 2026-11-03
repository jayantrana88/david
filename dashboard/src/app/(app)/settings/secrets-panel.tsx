"use client";

import { useActionState, useState } from "react";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/confirm-action";
import { StatusBadge } from "@/components/status-badge";
import type { SecretKey, SecretStatus } from "@/lib/data/settings";
import type { ActionResult } from "@/lib/types";
import { clearSecretAction, setSecretAction } from "./actions";

const META: Record<SecretKey, { label: string; usedBy: string }> = {
  ai_api_key: { label: "AI provider", usedBy: "For the model above" },
  jina_api_key: { label: "Jina Reader", usedBy: "Reads company websites" },
  serper_api_key: { label: "Serper", usedBy: "LinkedIn search" },
  telegram_bot_token: { label: "Telegram bot token", usedBy: "From @BotFather" },
  telegram_chat_id: { label: "Telegram chat ID", usedBy: "Where the bot posts" },
  gmail_client_id: { label: "Gmail client ID", usedBy: "Google Cloud OAuth client" },
  gmail_client_secret: { label: "Gmail client secret", usedBy: "For Gmail sending" },
  outlook_client_id: { label: "Outlook client ID", usedBy: "Microsoft Entra app" },
  outlook_client_secret: { label: "Outlook client secret", usedBy: "Only for a Web app" },
};

export function SecretsPanel({ secrets }: { secrets: SecretStatus[] }) {
  return (
    <section className="rounded-xl border bg-card shadow-card">
      <header className="border-b px-6 py-5">
        <h2 className="text-sm font-semibold">API keys</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Saved unencrypted on this computer. Hidden once saved.
        </p>
      </header>
      <ul className="divide-y">
        {secrets.map((s) => (
          <SecretRow key={s.key} secret={s} />
        ))}
      </ul>
    </section>
  );
}

function SecretRow({ secret }: { secret: SecretStatus }) {
  const meta = META[secret.key];
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState<ActionResult, FormData>(async (prev, form) => {
    const result = await setSecretAction(secret.key, prev, form);
    if (result?.ok) {
      setEditing(false);
    } else toast.error(result?.message ?? "Something went wrong");
    return result;
  }, null);

  return (
    <li className="px-6 py-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-subtle">
          <KeyRound className="size-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{meta.label}</p>
          <p className="text-[13px] text-muted-foreground">{meta.usedBy}</p>
        </div>
        {secret.set ? (
          <span className="flex items-center gap-2">
            <StatusBadge tone="success">Set</StatusBadge>
            <code className="font-mono text-xs text-muted-foreground">••••{secret.last4}</code>
          </span>
        ) : (
          <StatusBadge tone="neutral">Not set</StatusBadge>
        )}
        <div className="flex gap-1.5">
          {!editing && (
            <Button variant="outline" className="h-8 px-3" onClick={() => setEditing(true)}>
              {secret.set ? "Replace" : "Add key"}
            </Button>
          )}
          {secret.set && !editing && (
            <ConfirmAction
              action={() => clearSecretAction(secret.key)}
              trigger={
                <Button variant="ghost" className="h-8 px-3 text-muted-foreground hover:text-danger">
                  Clear
                </Button>
              }
              title={`Clear the ${meta.label} key?`}
              description="Without a key, the pools that need it don't start."
              confirmLabel="Clear key"
              destructive
            />
          )}
        </div>
      </div>
      {editing && (
        <form action={action} className="mt-3 flex flex-wrap gap-2 pl-13">
          <input
            name="value"
            type="password"
            autoComplete="off"
            autoFocus
            placeholder={`Paste the ${meta.label} key`}
            className="input h-9 min-w-64 flex-1 font-mono text-[13px]"
            aria-invalid={!!state?.fieldErrors?.value}
          />
          <Button type="button" variant="outline" className="h-9 px-3.5" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button type="submit" className="h-9 px-4" disabled={pending}>
            {pending ? "Saving…" : "Save key"}
          </Button>
        </form>
      )}
    </li>
  );
}
