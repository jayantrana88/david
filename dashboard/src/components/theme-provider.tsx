"use client";

import { ThemeProvider as NextThemes } from "next-themes";

/** Light / dark / system, stored in localStorage; the `.dark` class on <html> switches the tokens in globals.css. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemes attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </NextThemes>
  );
}
