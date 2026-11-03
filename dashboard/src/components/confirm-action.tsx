"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/types";

/**
 * A button that asks first, then runs a Server Action and toasts its result. The action revalidates the
 * page itself, so the list updates on its own.
 */
export function ConfirmAction({
  action,
  trigger,
  title,
  description,
  confirmLabel,
  destructive,
}: {
  action: () => Promise<ActionResult>;
  trigger: React.ReactElement;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  destructive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  const run = () =>
    start(async () => {
      const result = await action();
      if (result?.ok) toast.success(result.message);
      else toast.error(result?.message ?? "Something went wrong");
      setOpen(false);
    });

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={trigger} />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button variant={destructive ? "destructive" : "default"} onClick={run} disabled={pending}>
            {pending ? "Working…" : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Runs a Server Action without asking (for harmless, reversible changes) and toasts its result. */
export function useActionToast() {
  const [pending, start] = useTransition();
  const run = (action: () => Promise<ActionResult>) =>
    start(async () => {
      const result = await action();
      if (result?.ok) toast.success(result.message);
      else toast.error(result?.message ?? "Something went wrong");
    });
  return { pending, run };
}
