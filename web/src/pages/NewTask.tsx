import { useActionState, useState } from "react";
import { useNavigate } from "react-router-dom";
import Link from "@/components/link";
import { toast } from "sonner";
import { ArrowRight, Info, MapPin, Tag } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/form";
import { MAX_TASKS_PER_SUBMIT } from "@/lib/constants";
import type { ActionResult } from "@/lib/types";
import { createTasksAction } from "@/lib/actions";
import { PageHeader } from "@/components/page-header";

const split = (v: string) =>
  v
    .split(/[\n;]/)
    .map((s) => s.trim())
    .filter(Boolean);

function NewTaskForm() {
  const navigate = useNavigate();
  const [state, action, pending] = useActionState<ActionResult, FormData>(async (prev, form) => {
    const result = await createTasksAction(prev, form);
    if (result?.ok) {
      toast.success(result.message);
      navigate("/tasks");
    } else if (result && !result.fieldErrors) toast.error(result.message);
    return result;
  }, null);
  const [categories, setCategories] = useState("");
  const [locations, setLocations] = useState("");
  const [candidates, setCandidates] = useState("20");

  const cats = split(categories);
  const locs = split(locations);
  const total = cats.length * locs.length;
  const tooMany = total > MAX_TASKS_PER_SUBMIT;
  const err = state?.fieldErrors ?? {};

  return (
    <form action={action} className="grid gap-6 xl:grid-cols-[1fr_360px]">
      <div className="rounded-xl border bg-card shadow-card">
        <div className="grid gap-6 p-6 md:grid-cols-2">
          <Field
            label="Company categories"
            htmlFor="categories"
            error={err.categories}
            hint="One per line: the kind of company you'd like to work at, e.g. software company, design agency."
          >
            <textarea
              id="categories"
              name="categories"
              rows={5}
              className="input"
              placeholder={"software company\ndesign agency"}
              value={categories}
              onChange={(e) => setCategories(e.target.value)}
              aria-invalid={!!err.categories}
              autoFocus
            />
          </Field>
          <Field
            label="Locations"
            htmlFor="locations"
            error={err.locations}
            hint={'One per line: a city ("City, State/Country" to be exact), a region or a country.'}
          >
            <textarea
              id="locations"
              name="locations"
              rows={5}
              className="input"
              placeholder={"Chicago\nToronto, Ontario"}
              value={locations}
              onChange={(e) => setLocations(e.target.value)}
              aria-invalid={!!err.locations}
            />
          </Field>
          <Field
            label="Leads per search"
            htmlFor="candidates"
            error={err.candidates}
            hint="1–200. Fewer are saved if the search runs out of results."
          >
            <input
              id="candidates"
              name="candidates"
              type="number"
              min={1}
              max={200}
              required
              className="input tabular"
              value={candidates}
              onChange={(e) => setCandidates(e.target.value)}
              aria-invalid={!!err.candidates}
            />
          </Field>
          <Field
            label="Metro radius (km)"
            htmlFor="metro_radius_km"
            optional
            error={err.metro_radius_km}
            hint="City searches also accept companies this close. Empty = 30 km, 0 = the exact city."
          >
            <input
              id="metro_radius_km"
              name="metro_radius_km"
              type="number"
              min={0}
              step="any"
              className="input tabular"
              placeholder="30"
              aria-invalid={!!err.metro_radius_km}
            />
          </Field>
          <Field
            label="Max employees"
            htmlFor="max_employees"
            error={err.max_employees}
            hint="Skip companies bigger than this. LinkedIn shows size bands, so 50 accepts “11-50” but not “51-200”."
          >
            <input
              id="max_employees"
              name="max_employees"
              type="number"
              min={1}
              required
              className="input tabular"
              defaultValue={50}
              aria-invalid={!!err.max_employees}
            />
          </Field>
          <Field
            label="Looking for"
            htmlFor="opportunity_type"
            optional
            error={err.opportunity_type}
            hint="Empty = what your profile says."
          >
            <select id="opportunity_type" name="opportunity_type" className="input" defaultValue="">
              <option value="">From my profile</option>
              <option value="job">A job</option>
              <option value="internship">An internship</option>
              <option value="either">Either</option>
            </select>
          </Field>
          <Field
            label="Role"
            htmlFor="target_role"
            optional
            error={err.target_role}
            hint="e.g. Frontend Developer. Empty = the roles derived from your resume."
            className="md:col-span-2"
          >
            <input id="target_role" name="target_role" className="input" maxLength={200} aria-invalid={!!err.target_role} />
          </Field>
          <label className="flex items-start gap-3 text-sm md:col-span-2">
            <input type="checkbox" name="repeat_daily" className="mt-0.5 size-4" />
            <span>
              <span className="font-medium">Repeat daily</span>
              <span className="block text-[13px] text-muted-foreground">
                Run each of these searches again 24 hours after it finishes. Companies already saved are skipped, so
                every run looks for new ones.
              </span>
            </span>
          </label>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-b-xl border-t bg-subtle px-6 py-4">
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Info className="size-4 shrink-0" />
            Source: LinkedIn company pages. Tasks run one at a time, oldest first. Each company that fits
            gets an application email with your resume.
          </p>
          <div className="flex items-center gap-2">
            <Link href="/tasks" className={buttonVariants({ variant: "outline", className: "h-9 px-3.5" })}>
              Cancel
            </Link>
            <Button type="submit" className="h-9 gap-1.5 px-4" disabled={pending || total === 0 || tooMany}>
              {pending ? "Adding…" : total > 1 ? `Add ${total} tasks` : "Add task"}
              {!pending && <ArrowRight className="size-4" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Preview */}
      <aside className="h-fit rounded-xl border bg-card shadow-card xl:sticky xl:top-8">
        <div className="border-b px-5 py-4">
          <h2 className="text-[15px] font-semibold">Preview</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Every category × location pair becomes its own task.
          </p>
        </div>
        <div className="p-5">
          {total === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Add a category and a location to see the searches.</p>
          ) : (
            <>
              <p className={`mb-3 text-sm font-medium ${tooMany ? "text-danger" : ""}`}>
                {total} {total === 1 ? "search" : "searches"}
                {Number(candidates) > 0 && !tooMany && (
                  <span className="font-normal text-muted-foreground"> · up to {total * Number(candidates)} companies</span>
                )}
                {tooMany && <span className="font-normal"> — at most {MAX_TASKS_PER_SUBMIT} at a time</span>}
              </p>
              <ul className="max-h-80 space-y-1.5 overflow-y-auto">
                {cats.slice(0, 20).flatMap((c) =>
                  locs.slice(0, 20).map((l) => (
                    <li key={`${c}|${l}`} className="flex items-center gap-2 rounded-lg bg-subtle px-3 py-2 text-[13px]">
                      <Tag className="size-3.5 shrink-0 text-brand" />
                      <span className="truncate font-medium">{c}</span>
                      <MapPin className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate text-secondary-foreground">{l}</span>
                    </li>
                  )),
                )}
              </ul>
            </>
          )}
        </div>
      </aside>
    </form>
  );
}

export default function NewTask() {
  return (
    <>
      <PageHeader
        title="New task"
        description="Tell the pipeline where to look. Each task is one LinkedIn search for a kind of company in a location, limited to small companies; the ones it saves flow on to the fit check and your application email by themselves."
      />
      <NewTaskForm />
    </>
  );
}
