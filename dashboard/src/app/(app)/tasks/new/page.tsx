import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { NewTaskForm } from "./new-task-form";

export const metadata: Metadata = { title: "New task" };

export default async function NewTaskPage() {
  return (
    <>
      <PageHeader
        title="New task"
        description="Tell the daemon where to look. Each task is one LinkedIn search for a kind of company in a location, limited to small companies; the ones it saves flow on to the fit check and your application email by themselves."
      />
      <NewTaskForm />
    </>
  );
}
