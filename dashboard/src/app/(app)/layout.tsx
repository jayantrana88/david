import { MobileNav, Sidebar } from "@/components/shell/sidebar";
import { Shortcuts } from "@/components/shell/shortcuts";

// Every page reads the live database, so none may be prerendered at build time.
export const dynamic = "force-dynamic";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-svh">
      <Sidebar />
      <div className="app-glow min-w-0 flex-1">
        <MobileNav />
        <main className="mx-auto w-full max-w-[1280px] px-5 py-8 sm:px-8 lg:px-10">{children}</main>
      </div>
      <Shortcuts />
    </div>
  );
}
