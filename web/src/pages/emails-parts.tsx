import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/confirm-action";
import { retryEmailAction } from "@/lib/actions";

export function RetryEmailButton({ id, to }: { id: string; to: string }) {
  return (
    <ConfirmAction
      action={() => retryEmailAction(id)}
      trigger={
        <Button variant="ghost" size="icon-sm" aria-label="Retry" title="Retry" className="text-muted-foreground hover:text-foreground">
          <RotateCcw className="size-4" />
        </Button>
      }
      title="Write this email again?"
      description={
        <>
          This row is deleted and the email pool writes a new email to <strong>{to}</strong>. If email is in{" "}
          <strong>send</strong> mode, it goes out for real.
        </>
      }
      confirmLabel="Retry email"
    />
  );
}
