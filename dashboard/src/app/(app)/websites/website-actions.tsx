"use client";

import { useActionState, useState } from "react";
import { toast } from "sonner";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ConfirmAction } from "@/components/confirm-action";
import { IconButton } from "@/components/icon-button";
import { Field } from "@/components/form";
import type { ActionResult, Website } from "@/lib/types";
import { deleteWebsiteAction, updateWebsiteAction } from "./actions";

export function WebsiteActions({ website }: { website: Website }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="inline-flex items-center gap-0.5">
      <IconButton label="Edit contact details" onClick={() => setEditing(true)}>
        <Pencil className="size-4" />
      </IconButton>
      <ConfirmAction
        action={() => deleteWebsiteAction(website.id)}
        trigger={
          <Button variant="ghost" size="icon-sm" aria-label="Delete" title="Delete" className="text-muted-foreground hover:text-danger">
            <Trash2 className="size-4" />
          </Button>
        }
        title={`Delete ${website.name}?`}
        description="The lead is removed from Websites. Depending on your database rules, its scrape, pages and email are deleted with it, or the delete is refused while they exist."
        confirmLabel="Delete lead"
        destructive
      />
      <EditSheet website={website} open={editing} onOpenChange={setEditing} />
    </div>
  );
}

function EditSheet({ website, open, onOpenChange }: { website: Website; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(async (prev, form) => {
    const result = await updateWebsiteAction(website.id, prev, form);
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
          <SheetTitle className="text-base">{website.name}</SheetTitle>
          <SheetDescription>Contact details. The email pool writes to the first usable address.</SheetDescription>
        </SheetHeader>
        <form action={action} className="flex flex-1 flex-col">
          <div className="flex-1 space-y-5 overflow-y-auto p-6">
            <Field label="Email" htmlFor="email" optional error={err.email} hint="Several addresses: separate them with commas.">
              <input id="email" name="email" defaultValue={website.email ?? ""} className="input" placeholder="hello@company.com" />
            </Field>
            <Field label="Phone" htmlFor="phone_number" optional error={err.phone_number}>
              <input id="phone_number" name="phone_number" defaultValue={website.phone_number ?? ""} className="input" />
            </Field>
            <Field label="Owner" htmlFor="owner" optional error={err.owner}>
              <input id="owner" name="owner" defaultValue={website.owner ?? ""} className="input" />
            </Field>
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
