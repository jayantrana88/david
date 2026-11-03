import { readResume } from "@/lib/data/profile";

export const dynamic = "force-dynamic";

/** The stored resume file, for the profile page's "View" link. */
export async function GET() {
  const resume = readResume();
  if (!resume) return new Response("No resume uploaded.", { status: 404 });
  return new Response(new Uint8Array(resume.bytes), {
    headers: {
      "Content-Type": resume.mime,
      "Content-Disposition": `inline; filename="${encodeURIComponent(resume.filename)}"`,
    },
  });
}
