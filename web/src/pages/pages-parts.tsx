import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmAction } from "@/components/confirm-action";
import { pageContentAction, rereadPagesAction } from "@/lib/actions";

/** Pull readable text out of whatever Jina returned (content_json). */
function readable(content: unknown): { title?: string; text: string } {
  if (content == null) return { text: "" };
  if (typeof content === "string") return { text: content };
  if (typeof content === "object") {
    const c = content as Record<string, unknown>;
    const inner = (c.data && typeof c.data === "object" ? c.data : c) as Record<string, unknown>;
    const text = [inner.content, inner.text, inner.markdown, inner.summary].find((v) => typeof v === "string") as
      | string
      | undefined;
    if (text) return { title: typeof inner.title === "string" ? inner.title : undefined, text };
  }
  return { text: JSON.stringify(content, null, 2) };
}

/** A page's content, loaded when its row is opened. */
export function PageContent({ id }: { id: string }) {
  const [content, setContent] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    pageContentAction(id)
      .then(setContent)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) return <p className="text-[13px] text-danger">{error}</p>;
  if (content === undefined) return <Skeleton className="h-40 w-full" />;
  if (content === null) {
    return (
      <p className="text-[13px] text-muted-foreground">
        No content: every internal link failed to read. The internal pool retries this lead later.
      </p>
    );
  }
  const { title, text } = readable(content);
  return (
    <div>
      {title && <p className="mb-2 text-sm font-semibold">{title}</p>}
      <pre className="max-h-96 overflow-auto rounded-lg bg-subtle p-4 font-sans text-[13px] leading-relaxed whitespace-pre-wrap text-secondary-foreground">
        {text}
      </pre>
    </div>
  );
}

export function RereadButton({ scrapeId, name }: { scrapeId: string; name: string }) {
  return (
    <ConfirmAction
      action={() => rereadPagesAction(scrapeId)}
      trigger={
        <Button variant="ghost" size="icon-sm" aria-label="Read pages again" title="Read pages again" className="text-muted-foreground hover:text-foreground">
          <RefreshCw className="size-4" />
        </Button>
      }
      title={`Read ${name}'s pages again?`}
      description="All of this lead's pages are deleted and the internal pool reads them again from its website."
      confirmLabel="Delete & re-read"
      destructive
    />
  );
}
