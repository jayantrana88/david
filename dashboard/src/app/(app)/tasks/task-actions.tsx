"use client";

import { useActionState, useState } from "react";
import { toast } from "sonner";
import { Pencil, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { IconButton } from "@/components/icon-button";
import { ConfirmAction } from "@/components/confirm-action";
import { Field } from "@/components/form";
import type { ActionResult, Task } from "@/lib/types";
import { Switch } from "@/components/ui/switch";
import { deleteTaskAction, requeueTaskAction, setTaskRepeatAction, updateTaskAction } from "./actions";

/** The daily-repeat switch of a task row; works in any status. */
export function RepeatToggle({ task }: { task: Task }) {
  const [on, setOn] = useState(!!task.repeat_daily);
  return (
    <Switch
      size="sm"
      checked={on}
      aria-label="Repeat daily"
      title={on ? "Runs again every day" : "Runs once"}
      onCheckedChange={async (next) => {
        setOn(next);
        const result = await setTaskRepeatAction(task.id, next);
        if (result?.ok) toast.success(result.message);
        else {
          setOn(!next);
          toast.error(result?.message ?? "Something went wrong");
        }
      }}
    />
  );
}

export function TaskActions({ task }: { task: Task }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="inline-flex items-center gap-0.5">
      {task.status === "pending" && (
        <IconButton label="Edit" onClick={() => setEditing(true)}>
          <Pencil className="size-4" />
        </IconButton>
      )}
      {(task.status === "completed" || task.status === "failed") && (
        <ConfirmAction
          action={() => requeueTaskAction(task.id)}
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label="Re-run" title="Re-run" className="text-muted-foreground hover:text-foreground">
              <RotateCcw className="size-4" />
            </Button>
          }
          title={`Re-run task #${task.id}?`}
          description={`"${task.category}" in ${task.location} goes back to pending and runs again in full. Leads it already saved are skipped as duplicates.`}
          confirmLabel="Re-run"
        />
      )}
      {task.status !== "running" && (
        <ConfirmAction
          action={() => deleteTaskAction(task.id)}
          trigger={
            <Button variant="ghost" size="icon-sm" aria-label="Delete" title="Delete" className="text-muted-foreground hover:text-danger">
              <Trash2 className="size-4" />
            </Button>
          }
          title={`Delete task #${task.id}?`}
          description="The task is removed from the queue. Leads it already saved stay in Websites."
          confirmLabel="Delete task"
          destructive
        />
      )}
      {task.status === "pending" && <EditTaskSheet task={task} open={editing} onOpenChange={setEditing} />}
    </div>
  );
}

function EditTaskSheet({ task, open, onOpenChange }: { task: Task; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(async (prev, form) => {
    const result = await updateTaskAction(task.id, prev, form);
    if (result?.ok) {
      toast.success(result.message);
      onOpenChange(false);
    } else if (result && !result.fieldErrors) toast.error(result.message);
    return result;
  }, null);
  const err = state?.fieldErrors ?? {};

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 text-left sm:max-w-md">
        <SheetHeader className="border-b p-6">
          <SheetTitle className="text-base">Edit task #{task.id}</SheetTitle>
          <SheetDescription>Only a task that hasn&apos;t started yet can be changed.</SheetDescription>
        </SheetHeader>
        <form action={action} className="flex flex-1 flex-col">
          <div className="flex-1 space-y-5 overflow-y-auto p-6">
            <Field label="Business category" htmlFor="category" error={err.category}>
              <input id="category" name="category" defaultValue={task.category} className="input" required />
            </Field>
            <Field label="Location" htmlFor="location" error={err.location}>
              <input id="location" name="location" defaultValue={task.location} className="input" required />
            </Field>
            <Field label="Leads to save" htmlFor="candidates" error={err.candidates} hint="1–200.">
              <input id="candidates" name="candidates" type="number" min={1} max={200} defaultValue={task.candidates} className="input" required />
            </Field>
            <Field label="Metro radius (km)" htmlFor="metro_radius_km" optional error={err.metro_radius_km} hint="Empty = 30 km, 0 = the exact city.">
              <input
                id="metro_radius_km"
                name="metro_radius_km"
                type="number"
                min={0}
                step="any"
                defaultValue={task.metro_radius_km ?? ""}
                className="input"
                placeholder="30"
              />
            </Field>
            <Field label="Max employees" htmlFor="max_employees" error={err.max_employees} hint="Companies in a bigger size band are skipped.">
              <input id="max_employees" name="max_employees" type="number" min={1} defaultValue={task.max_employees} className="input" required />
            </Field>
            <Field label="Looking for" htmlFor="opportunity_type" optional error={err.opportunity_type}>
              <select id="opportunity_type" name="opportunity_type" defaultValue={task.opportunity_type ?? ""} className="input">
                <option value="">From my profile</option>
                <option value="job">A job</option>
                <option value="internship">An internship</option>
                <option value="either">Either</option>
              </select>
            </Field>
            <Field label="Role" htmlFor="target_role" optional error={err.target_role} hint="Empty = the roles from your profile.">
              <input id="target_role" name="target_role" defaultValue={task.target_role ?? ""} className="input" maxLength={200} />
            </Field>
            <label className="flex items-center gap-3 text-sm font-medium">
              <input type="checkbox" name="repeat_daily" defaultChecked={!!task.repeat_daily} className="size-4" />
              Repeat daily
            </label>
          </div>
          <SheetFooter className="flex-row justify-end gap-2 border-t p-4">
            <Button type="button" variant="outline" className="h-9 px-3.5" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="h-9 px-4" disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
