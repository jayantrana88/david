import { Outlet, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { MobileNav, Sidebar } from "@/components/shell/sidebar";
import { Shortcuts } from "@/components/shell/shortcuts";

export function AppLayout() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return (
    <div className="flex min-h-svh">
      <Sidebar />
      <div className="app-glow min-w-0 flex-1">
        <MobileNav />
        <main className="mx-auto w-full max-w-[1280px] px-5 py-8 sm:px-8 lg:px-10">
          <Outlet />
        </main>
      </div>
      <Shortcuts />
    </div>
  );
}
