import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { SessionContext } from "@/components/session";
import { AppLayout } from "@/components/shell/layout";
import { Skeleton } from "@/components/ui/skeleton";
import { setSignedOutHandler, useApi } from "@/lib/api";
import Emails from "@/pages/Emails";
import Logs from "@/pages/Logs";
import NewTask from "@/pages/NewTask";
import Overview from "@/pages/Overview";
import Pages from "@/pages/Pages";
import Profile from "@/pages/Profile";
import Scrapes from "@/pages/Scrapes";
import Settings from "@/pages/Settings";
import Tasks from "@/pages/Tasks";
import Unlock from "@/pages/Unlock";
import Websites from "@/pages/Websites";

type SessionInfo = { locked: boolean; signedIn: boolean; worker: boolean };

function Gate() {
  const { data, error, reload } = useApi<SessionInfo>("/api/session");
  const [signedOut, setSignedOut] = useState(false);
  useEffect(() => {
    setSignedOutHandler(() => setSignedOut(true));
  }, []);

  if (error) {
    return (
      <main className="flex min-h-svh items-center justify-center px-5 text-center text-sm text-muted-foreground">
        <div>
          <p className="font-medium text-foreground">Couldn&apos;t reach the server</p>
          <p className="mt-1">{error}</p>
          <button className="mt-4 underline underline-offset-2" onClick={reload}>
            Try again
          </button>
        </div>
      </main>
    );
  }
  if (!data) {
    return (
      <div className="p-10">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }
  if (data.locked && (!data.signedIn || signedOut)) {
    return (
      <Unlock
        onUnlocked={() => {
          setSignedOut(false);
          reload();
        }}
      />
    );
  }

  return (
    <SessionContext.Provider value={{ worker: data.worker }}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route index element={<Overview />} />
            <Route path="profile" element={<Profile />} />
            <Route path="tasks" element={<Tasks />} />
            <Route path="tasks/new" element={<NewTask />} />
            <Route path="websites" element={<Websites />} />
            <Route path="scrapes" element={<Scrapes />} />
            <Route path="pages" element={<Pages />} />
            <Route path="emails" element={<Emails />} />
            <Route path="logs" element={<Logs />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </SessionContext.Provider>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <Gate />
      <Toaster position="bottom-center" richColors closeButton />
    </ThemeProvider>
  );
}
