"use client";

import { useActionState, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormSection } from "@/components/form";
import type { SettingsFields } from "@/lib/data/settings";
import { DELIVERY_LABEL, EMAIL_DELIVERIES, type ActionResult } from "@/lib/types";
import { saveSettingsAction } from "./actions";

const FALLBACK = "Default";

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

export function SettingsForm({ initial }: { initial: SettingsFields }) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(async (prev, form) => {
    const result = await saveSettingsAction(prev, form);
    if (result?.ok) {
      setDirty(false);
    } else toast.error(result?.message ?? "Something went wrong");
    return result;
  }, null);
  const [dirty, setDirty] = useState(false);

  const err = state?.fieldErrors ?? {};

  const input = (name: keyof SettingsFields, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input
      id={name}
      name={name}
      defaultValue={str(initial[name])}
      placeholder={FALLBACK}
      className="input"
      aria-invalid={!!err[name]}
      {...props}
    />
  );

  return (
    <>
      <form
        action={action}
        onChange={() => setDirty(true)}
        className="rounded-xl border bg-card shadow-card"
      >
        <div className="divide-y px-6 py-7">
          <FormSection
            title="AI"
            description="Reads your resume, picks companies and writes the emails."
          >
            <Field
              label="Model"
              htmlFor="ai_model"
              error={err.ai_model}
              hint="provider/model. Empty = Cloudflare Gemma."
            >
              {input("ai_model", { placeholder: "groq/openai/gpt-oss-120b" })}
            </Field>
            <Field
              label="Cloudflare account ID"
              htmlFor="cloudflare_account_id"
              error={err.cloudflare_account_id}
              hint="Only needed when Model is empty."
            >
              {input("cloudflare_account_id")}
            </Field>
            <Field
              label="Email writing rules"
              htmlFor="email_instructions"
              optional
              className="sm:col-span-2"
              error={err.email_instructions}
              hint="Tone, format, what to mention. Length and no-list rules still apply."
            >
              <textarea
                id="email_instructions"
                name="email_instructions"
                rows={5}
                maxLength={2000}
                defaultValue={str(initial.email_instructions)}
                placeholder={"e.g. Keep a formal tone.\nAlways mention I can start in June.\nEnd by asking for a 15 minute call."}
                className="input"
                aria-invalid={!!err.email_instructions}
              />
            </Field>
          </FormSection>

          <FormSection
            title="Email"
            description="Where finished applications go."
          >
            <Field
              label="Delivery"
              htmlFor="email_delivery"
              error={err.email_delivery}
              hint="Telegram: you send by hand. Gmail / Outlook: sent for you."
            >
              <select id="email_delivery" name="email_delivery" defaultValue={initial.email_delivery ?? "telegram"} className="input">
                {EMAIL_DELIVERIES.map((d) => (
                  <option key={d} value={d}>
                    {d === "telegram" ? "Telegram (send by hand)" : DELIVERY_LABEL[d]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Max sends per day" htmlFor="email_max_sends_per_day" error={err.email_max_sends_per_day} hint="Empty = no limit.">
              {input("email_max_sends_per_day", { type: "number", min: 1 })}
            </Field>
          </FormSection>
        </div>

        <div className="sticky bottom-0 flex items-center justify-between gap-4 rounded-b-xl border-t bg-card/95 px-6 py-4 backdrop-blur">
          <p className="text-[13px] text-muted-foreground">
            {dirty ? "You have unsaved changes." : ""}
          </p>
          <div className="flex gap-2">
            <Button type="reset" variant="outline" className="h-9 px-3.5" disabled={!dirty || pending} onClick={() => setDirty(false)}>
              Discard
            </Button>
            <Button type="submit" className="h-9 px-4" disabled={pending}>
              {pending ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}
