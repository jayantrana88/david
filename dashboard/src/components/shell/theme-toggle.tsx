"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const THEMES: { value: string; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const noop = () => () => {};

/** False on the server and during hydration: the stored theme is only known in the browser. */
function useMounted() {
  return useSyncExternalStore(noop, () => true, () => false);
}

/** Light / Dark / System segmented control (sidebar footer). */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted/70 p-0.5">
      {THEMES.map((t) => {
        const active = mounted && theme === t.value;
        return (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={t.label}
            title={t.label}
            onClick={() => setTheme(t.value)}
            className={cn(
              "flex h-7 items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors",
              active ? "bg-card text-foreground shadow-card ring-1 ring-border" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <t.icon className="size-3.5" />
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** One button that cycles light → dark → system (mobile top bar). */
export function ThemeToggleButton({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const i = THEMES.findIndex((t) => t.value === theme);
  const current = mounted && i >= 0 ? THEMES[i] : THEMES[2];
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
  return (
    <button
      type="button"
      onClick={() => setTheme(next.value)}
      aria-label={`Theme: ${current.label}. Switch to ${next.label}`}
      title={`Theme: ${current.label}`}
      className={cn(
        "flex size-8 items-center justify-center rounded-lg border bg-card text-muted-foreground shadow-card transition-colors hover:text-foreground",
        className,
      )}
    >
      <current.icon className="size-4" />
    </button>
  );
}
