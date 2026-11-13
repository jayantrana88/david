import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";

/** A list page while its first answer loads. */
export function ListSkeleton({ title }: { title: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Skeleton className="mb-4 h-10 w-full max-w-xl rounded-xl" />
      <div className="overflow-hidden rounded-xl border bg-card shadow-card">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="border-b px-5 py-4 last:border-b-0">
            <Skeleton className="h-5 w-2/3" />
          </div>
        ))}
      </div>
    </>
  );
}
