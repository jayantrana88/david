import type { Metadata } from "next";
import { getProfile } from "@/lib/data/profile";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/empty-state";
import { AutoRefresh } from "@/components/auto-refresh";
import { ProfileForms } from "./profile-forms";

export const metadata: Metadata = { title: "Profile" };

export default async function ProfilePage() {
  let profile;
  try {
    profile = await getProfile();
  } catch (e) {
    return (
      <>
        <PageHeader title="Profile" />
        <ErrorState message={(e as Error).message} />
      </>
    );
  }

  return (
    <>
      <AutoRefresh active={profile?.parse_status === "pending"} seconds={5} />
      <PageHeader
        title="Profile"
        description="Your resume goes out with every email. The daemon reads it, together with your notes, into the profile below; the profile decides which companies fit and what each email says."
      />
      <ProfileForms profile={profile ?? null} />
    </>
  );
}
