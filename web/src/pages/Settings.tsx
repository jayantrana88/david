import { useActionState, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, KeyRound, Lock, Mail, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/confirm-action";
import { Field, FormSection } from "@/components/form";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useApi } from "@/lib/api";
import {
  clearSecretAction,
  disconnectMailboxAction,
  removeLockAction,
  saveSettingsAction,
  setLockAction,
  setSecretAction,
  testSendAction,
} from "@/lib/actions";
import { timeAgo } from "@/lib/format";
import { DELIVERY_LABEL, EMAIL_DELIVERIES, type ActionResult } from "@/lib/types";

/** The Worker has all of these; the local dashboard has the AI model, the account ID and the email ones. */
type Fields = {
  ai_model: string | null;
  cloudflare_account_id?: string | null;
  ai_base_url?: string | null;
  ai_qualify_batch?: number;
  ai_email_batch?: number;
  email_mode: "dry_run" | "send";
  email_delivery: (typeof EMAIL_DELIVERIES)[number];
  email_max_sends_per_day: number | null;
  sender_name?: string | null;
  email_enabled: boolean;
  email_attach_resume?: boolean;
  email_instructions: string | null;
  linkedin_transport?: "fetch" | "browser";
  sourcing_per_tick?: number;
  outlook_tenant?: string | null;
  paused?: boolean;
};

type SettingsData = {
  /** Where the API runs: on the Worker (changes apply at the next tick) or beside the daemon (it restarts to apply them). */
  host: "worker" | "local";
  daemon?: { applied_version: number | null; applied_at: string | null; apply_error: string | null };
  fields: Fields;
  defaultModel: string;
  secrets: { key: string; label: string; help: string; set: boolean; last4: string | null }[];
  mailboxes: { provider: "gmail" | "outlook"; label: string; email: string | null; saved_at: string | null; redirect_uri: string }[];
  lock: { locked: boolean; fromSecret: boolean; minLength: number };
  meta: { version: number; updated_at: string | null };
};

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

export default function Settings() {
  const { data, error } = useApi<SettingsData>("/api/settings");
  const [sp, setSp] = useSearchParams();

  // Gmail / Outlook sign-in comes back here with ?msg=&ok=
  useEffect(() => {
    const msg = sp.get("msg");
    if (!msg) return;
    if (sp.get("ok") === "0") toast.error(msg);
    else toast.success(msg);
    setSp({}, { replace: true });
  }, [sp, setSp]);

  if (error && !data) {
    return (
      <>
        <PageHeader title="Settings" />
        <ErrorState message={error} />
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="Settings"
        description={
          data?.host === "local"
            ? "Empty fields use the defaults. The daemon restarts by itself to apply a change."
            : "Empty fields use the defaults. Changes apply at the next scheduled tick; nothing to restart."
        }
      />
      {!data ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : (
        <>
          {data.host === "local" ? <DaemonStatus daemon={data.daemon} /> : <Status paused={!!data.fields.paused} />}
          <div className="mt-6 space-y-6">
            <SettingsForm initial={data.fields} defaultModel={data.defaultModel} host={data.host} />
            <SecretsPanel secrets={data.secrets} host={data.host} />
            {data.host === "worker" && <MailboxesPanel mailboxes={data.mailboxes} delivery={data.fields.email_delivery} />}
            <LockPanel lock={data.lock} />
          </div>
          <p className="mt-6 text-xs text-muted-foreground">
            Settings version {data.meta.version}
            {data.meta.updated_at && ` · last changed ${timeAgo(data.meta.updated_at)}`}
            {data.daemon?.applied_version != null && ` · daemon loaded version ${data.daemon.applied_version} ${timeAgo(data.daemon.applied_at)}`}
          </p>
        </>
      )}
    </>
  );
}

/** The local daemon: has it loaded the saved settings, or refused to start with them? */
function DaemonStatus({ daemon }: { daemon: SettingsData["daemon"] }) {
  if (daemon?.apply_error) {
    return (
      <div className="flex gap-3 rounded-xl border border-danger-ring bg-danger-soft px-5 py-4 text-danger">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 text-[13px] leading-relaxed">
          <p className="font-semibold">The daemon refused to start with these settings</p>
          <p className="mt-0.5 font-mono text-xs break-words text-foreground/80">{daemon.apply_error}</p>
          <p className="mt-1.5 text-foreground/80">Fix the value below, save, and start the daemon again. ({timeAgo(daemon.applied_at)})</p>
        </div>
      </div>
    );
  }
  const loaded = daemon?.applied_version != null;
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card px-5 py-3.5 shadow-card">
      <CheckCircle2 className="size-4 text-success" />
      <p className="text-[13px] text-secondary-foreground">
        {loaded ? "The daemon is running with the latest settings." : "No daemon has loaded these settings yet."}
      </p>
      <span className="ml-auto">
        <StatusBadge tone={loaded ? "success" : "neutral"}>{loaded ? "Running" : "Not started"}</StatusBadge>
      </span>
    </div>
  );
}

function Status({ paused }: { paused: boolean }) {
  if (paused) {
    return (
      <div className="flex gap-3 rounded-xl border border-warning-ring bg-warning-soft px-5 py-4 text-warning">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <div className="text-[13px] leading-relaxed">
          <p className="font-semibold">Paused</p>
          <p className="mt-0.5 text-foreground/80">The scheduled ticks do nothing. Untick “Pause” under Sourcing and save to resume.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card px-5 py-3.5 shadow-card">
      <CheckCircle2 className="size-4 text-success" />
      <p className="text-[13px] text-secondary-foreground">A tick every minute runs the pipeline with these settings.</p>
      <span className="ml-auto">
        <StatusBadge tone="success">Running</StatusBadge>
      </span>
    </div>
  );
}

// ── the settings form ────────────────────────────────────────────────────────────

function SettingsForm({ initial, defaultModel, host }: { initial: Fields; defaultModel: string; host: SettingsData["host"] }) {
  const worker = host === "worker";
  const [dirty, setDirty] = useState(false);
  const [state, action, pending] = useActionState<ActionResult, FormData>(async (prev, form) => {
    const result = await saveSettingsAction(prev, form);
    if (result?.ok) {
      setDirty(false);
      toast.success(result.message);
    } else toast.error(result?.message ?? "Something went wrong");
    return result;
  }, null);
  const err = state?.fieldErrors ?? {};

  const input = (name: keyof Fields, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input id={name} name={name} defaultValue={str(initial[name])} placeholder="Default" className="input" aria-invalid={!!err[name]} {...props} />
  );
  const select = (name: keyof Fields, options: [string, string][]) => (
    <select id={name} name={name} defaultValue={str(initial[name])} className="input">
      {options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
  const check = (name: keyof Fields, label: string, hint?: string) => (
    <label className="flex items-start gap-3 text-sm">
      <input type="checkbox" name={name} defaultChecked={Boolean(initial[name])} className="mt-0.5 size-4" />
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-[13px] text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );

  return (
    <form action={action} onChange={() => setDirty(true)} className="rounded-xl border bg-card shadow-card">
      <div className="divide-y px-6 py-7">
        <FormSection title="AI" description="Reads your resume, judges the companies and writes the applications.">
          <Field label="Model" htmlFor="ai_model" error={err.ai_model} hint={worker ? `Empty = Workers AI's ${defaultModel}.` : "provider/model. Empty = Cloudflare Gemma."}>
            {input("ai_model", { placeholder: worker ? defaultModel : "groq/openai/gpt-oss-120b" })}
          </Field>
          {worker ? (
            <>
              <Field
                label="OpenAI-compatible base URL"
                htmlFor="ai_base_url"
                optional
                error={err.ai_base_url}
                hint="Empty = Workers AI (a free 10,000 neurons a day). Needs the AI provider key below."
              >
                {input("ai_base_url", { placeholder: "https://api.groq.com/openai/v1" })}
              </Field>
              <Field label="Companies judged per AI call" htmlFor="ai_qualify_batch" error={err.ai_qualify_batch} hint="1–30.">
                {input("ai_qualify_batch", { type: "number", min: 1, max: 30, placeholder: "" })}
              </Field>
              <Field label="First drafts per AI call" htmlFor="ai_email_batch" error={err.ai_email_batch} hint="1–10.">
                {input("ai_email_batch", { type: "number", min: 1, max: 10, placeholder: "" })}
              </Field>
            </>
          ) : (
            <Field label="Cloudflare account ID" htmlFor="cloudflare_account_id" error={err.cloudflare_account_id} hint="Only needed when Model is empty.">
              {input("cloudflare_account_id")}
            </Field>
          )}
        </FormSection>

        <FormSection title="Applications" description="What is written, and where it goes.">
          <Field
            label="Mode"
            htmlFor="email_mode"
            error={err.email_mode}
            hint="Dry run saves drafts and sends nothing. Going to Send deletes the drafts, so those companies get a real application."
          >
            {select("email_mode", [
              ["dry_run", "Dry run: save drafts, send nothing"],
              ["send", "Send"],
            ])}
          </Field>
          <Field label="Delivery" htmlFor="email_delivery" error={err.email_delivery} hint="Telegram: you send by hand. Gmail / Outlook: sent for you.">
            {select(
              "email_delivery",
              EMAIL_DELIVERIES.map((d) => [d, d === "telegram" ? "Telegram (send by hand)" : DELIVERY_LABEL[d]]),
            )}
          </Field>
          <Field label="Max sends per day" htmlFor="email_max_sends_per_day" error={err.email_max_sends_per_day} hint="Empty = no limit.">
            {input("email_max_sends_per_day", { type: "number", min: 1 })}
          </Field>
          {worker && (
            <Field label="Sender name" htmlFor="sender_name" optional error={err.sender_name} hint="Empty = your profile's name.">
              {input("sender_name", { maxLength: 200 })}
            </Field>
          )}
          <div className="space-y-3 sm:col-span-2">
            {check("email_enabled", "Write applications")}
            {worker && check("email_attach_resume", "Attach my resume", "Waits until there is one.")}
          </div>
          <Field
            label="Writing rules"
            htmlFor="email_instructions"
            optional
            className="sm:col-span-2"
            error={err.email_instructions}
            hint="Tone, format, what to mention. Length (70–140 words), no dashes or lists, and only your own links still apply."
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

        {worker && (
          <FormSection title="Sourcing" description="How LinkedIn company pages are read, and the master switch.">
            <Field
              label="LinkedIn pages through"
              htmlFor="linkedin_transport"
              error={err.linkedin_transport}
              hint="Browser Rendering needs Workers Paid and the BROWSER binding."
            >
              {select("linkedin_transport", [
                ["fetch", "Plain fetch (often refused by LinkedIn)"],
                ["browser", "Browser Rendering (Workers Paid)"],
              ])}
            </Field>
            <Field label="LinkedIn pages per tick" htmlFor="sourcing_per_tick" error={err.sourcing_per_tick} hint="1–10.">
              {input("sourcing_per_tick", { type: "number", min: 1, max: 10, placeholder: "" })}
            </Field>
            <Field label="Outlook tenant" htmlFor="outlook_tenant" optional error={err.outlook_tenant} hint="Empty = common.">
              {input("outlook_tenant", { placeholder: "common", maxLength: 100 })}
            </Field>
            <div className="sm:self-end">{check("paused", "Pause", "The scheduled ticks do nothing.")}</div>
          </FormSection>
        )}
      </div>

      <div className="sticky bottom-0 flex items-center justify-between gap-4 rounded-b-xl border-t bg-card/95 px-6 py-4 backdrop-blur">
        <p className="text-[13px] text-muted-foreground">{dirty ? "You have unsaved changes." : ""}</p>
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
  );
}

// ── API keys ─────────────────────────────────────────────────────────────────────

function SecretsPanel({ secrets, host }: { secrets: SettingsData["secrets"]; host: SettingsData["host"] }) {
  return (
    <section id="keys" className="scroll-mt-6 rounded-xl border bg-card shadow-card">
      <header className="border-b px-6 py-5">
        <h2 className="text-sm font-semibold">API keys</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {host === "worker"
            ? "Stored in your D1 database as plain text; hidden once saved. Set a dashboard password below if the address could get out."
            : "Saved unencrypted on this computer, in the daemon's database. Hidden once saved."}
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

function SecretRow({ secret }: { secret: SettingsData["secrets"][number] }) {
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState<ActionResult, FormData>(async (prev, form) => {
    const result = await setSecretAction(secret.key, prev, form);
    if (result?.ok) {
      setEditing(false);
      toast.success(result.message);
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
          <p className="text-sm font-medium">{secret.label}</p>
          {secret.help && <p className="text-[13px] text-muted-foreground">{secret.help}</p>}
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
              title={`Clear the ${secret.label}?`}
              description="Without a key, the stages that need it don't start or hold."
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
            placeholder={`Paste the ${secret.label.toLowerCase()}`}
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

// ── Gmail / Outlook sign-in, and a sample send ───────────────────────────────────

function MailboxesPanel({ mailboxes, delivery }: { mailboxes: SettingsData["mailboxes"]; delivery: Fields["email_delivery"] }) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(async (prev, form) => {
    const result = await testSendAction(prev, form);
    if (result?.ok) toast.success(result.message);
    else toast.error(result?.message ?? "Something went wrong");
    return result;
  }, null);

  return (
    <section className="rounded-xl border bg-card shadow-card">
      <header className="border-b px-6 py-5">
        <h2 className="text-sm font-semibold">Mailboxes</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          For delivery by Gmail or Outlook: save the client ID and secret above, register the redirect URI in the OAuth client, then connect.
        </p>
      </header>
      <ul className="divide-y">
        {mailboxes.map((m) => (
          <li key={m.provider} className="px-6 py-4">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-subtle">
                <Mail className="size-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{m.label}</p>
                <p className="text-[13px] break-all text-muted-foreground">
                  Redirect URI: <code className="font-mono text-xs">{m.redirect_uri}</code>
                </p>
              </div>
              {m.saved_at ? (
                <span className="flex items-center gap-2">
                  <StatusBadge tone="success">Connected{m.email ? ` as ${m.email}` : ""}</StatusBadge>
                  <span className="text-xs text-muted-foreground">{timeAgo(m.saved_at)}</span>
                </span>
              ) : (
                <StatusBadge tone="neutral">Not connected</StatusBadge>
              )}
              <div className="flex gap-1.5">
                {/* a full navigation: the Worker redirects to the provider's sign-in */}
                <a href={`/oauth/${m.provider}/start`} className="inline-flex h-8 items-center rounded-lg border bg-card px-3 text-sm font-medium shadow-card hover:bg-accent">
                  {m.saved_at ? "Connect again" : "Connect"}
                </a>
                {m.saved_at && (
                  <ConfirmAction
                    action={() => disconnectMailboxAction(m.provider)}
                    trigger={
                      <Button variant="ghost" className="h-8 px-3 text-muted-foreground hover:text-danger">
                        Disconnect
                      </Button>
                    }
                    title={`Disconnect ${m.label}?`}
                    description="Its refresh token is deleted; connect again to send through it."
                    confirmLabel="Disconnect"
                    destructive
                  />
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <form action={action} className="flex flex-wrap items-center gap-2 border-t bg-subtle px-6 py-4">
        <Send className="size-4 text-muted-foreground" />
        <select name="channel" defaultValue={delivery} className="input h-9 w-auto min-w-36">
          {EMAIL_DELIVERIES.map((c) => (
            <option key={c} value={c}>
              {DELIVERY_LABEL[c]}
            </option>
          ))}
        </select>
        <input
          name="to"
          type="email"
          required
          placeholder="your own address"
          className="input h-9 min-w-56 flex-1"
          aria-invalid={!!state?.fieldErrors?.to}
        />
        <Button type="submit" variant="outline" className="h-9 px-3.5" disabled={pending}>
          {pending ? "Sending…" : "Send a sample"}
        </Button>
        <p className="w-full text-xs text-muted-foreground">Really sends one sample application (with your resume) to the address you give.</p>
      </form>
    </section>
  );
}

// ── the dashboard password ───────────────────────────────────────────────────────

function LockPanel({ lock }: { lock: SettingsData["lock"] }) {
  const { locked, fromSecret, minLength } = lock;
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState<ActionResult, FormData>(async (prev, form) => {
    const result = await setLockAction(prev, form);
    if (result?.ok) {
      setEditing(false);
      toast.success(result.message);
    } else toast.error(result?.message ?? "Something went wrong");
    return result;
  }, null);
  const [removing, setRemoving] = useState(false);
  const [current, setCurrent] = useState("");

  return (
    <section id="password" className="scroll-mt-6 rounded-xl border bg-card shadow-card">
      <header className="border-b px-6 py-5">
        <h2 className="text-sm font-semibold">Dashboard password</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">Optional. Asked once per browser every 30 days.</p>
      </header>
      <div className="px-6 py-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-subtle">
            <Lock className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Password</p>
            <p className="text-[13px] text-muted-foreground">
              {fromSecret
                ? "Set by the DASHBOARD_PASSWORD secret: change it under Workers & Pages → this Worker → Settings → Variables and Secrets."
                : locked
                  ? `At least ${minLength} characters.`
                  : "Open: anyone who has this address can use the dashboard, including your API keys and resume."}
            </p>
          </div>
          <StatusBadge tone={locked ? "success" : "warning"}>{locked ? "On" : "Off"}</StatusBadge>
          {!fromSecret && !editing && !removing && (
            <div className="flex gap-1.5">
              <Button variant="outline" className="h-8 px-3" onClick={() => setEditing(true)}>
                {locked ? "Change" : "Set a password"}
              </Button>
              {locked && (
                <Button variant="ghost" className="h-8 px-3 text-muted-foreground hover:text-danger" onClick={() => setRemoving(true)}>
                  Remove
                </Button>
              )}
            </div>
          )}
        </div>
        {editing && !fromSecret && (
          <form action={action} className="mt-3 flex flex-wrap gap-2 pl-13">
            {locked && (
              <input
                name="current"
                type="password"
                autoComplete="current-password"
                required
                placeholder="Current password"
                className="input h-9 min-w-48 flex-1"
                aria-invalid={!!state?.fieldErrors?.current}
              />
            )}
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              autoFocus
              required
              minLength={minLength}
              placeholder="New password"
              className="input h-9 min-w-48 flex-1"
              aria-invalid={!!state?.fieldErrors?.password}
            />
            <input
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              minLength={minLength}
              placeholder="Repeat it"
              className="input h-9 min-w-48 flex-1"
              aria-invalid={!!state?.fieldErrors?.confirm}
            />
            <Button type="button" variant="outline" className="h-9 px-3.5" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" className="h-9 px-4" disabled={pending}>
              {pending ? "Saving…" : "Save password"}
            </Button>
          </form>
        )}
        {removing && !fromSecret && (
          <div className="mt-3 flex flex-wrap gap-2 pl-13">
            <input
              type="password"
              autoComplete="current-password"
              autoFocus
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              placeholder="Current password"
              className="input h-9 min-w-48 flex-1"
            />
            <Button type="button" variant="outline" className="h-9 px-3.5" onClick={() => setRemoving(false)}>
              Cancel
            </Button>
            <ConfirmAction
              action={async () => {
                const result = await removeLockAction(current);
                if (result?.ok) {
                  setRemoving(false);
                  setCurrent("");
                }
                return result;
              }}
              trigger={
                <Button type="button" variant="destructive" className="h-9 px-4" disabled={!current}>
                  Remove password
                </Button>
              }
              title="Remove the password?"
              description="Anyone who has the dashboard's address can open it."
              confirmLabel="Remove password"
              destructive
            />
          </div>
        )}
      </div>
    </section>
  );
}
