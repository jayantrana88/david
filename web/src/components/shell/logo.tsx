import { useId } from "react";
import { cn } from "@/lib/utils";

/** The paper-plane mark: the same colours in both themes (app/icon.svg is its favicon copy). */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  // A per-instance id: a gradient referenced from inside a hidden (display:none) svg doesn't paint.
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={cn("shrink-0 drop-shadow-[0_2px_6px_rgba(99,102,241,0.35)]", className)}
    >
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366f1" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
        <linearGradient id={`${id}-shine`} x1="16" y1="0" x2="16" y2="18" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fff" stopOpacity="0.22" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8.5" fill={`url(#${id}-bg)`} />
      <rect width="32" height="32" rx="8.5" fill={`url(#${id}-shine)`} />
      <PlaneShapes />
    </svg>
  );
}

function PlaneShapes() {
  return (
    <>
      {/* motion trail */}
      <path d="M5.5 21.5 9 19.8M7.6 25.6l3.2-1.8" stroke="#fff" strokeOpacity="0.55" strokeWidth="1.6" strokeLinecap="round" />
      {/* upper wing, lower body, inner fold */}
      <path d="M24.5 7.5 6.8 14.6l6.2 2.7z" fill="#fff" />
      <path d="M24.5 7.5 13 17.3l4 8.2z" fill="#fff" fillOpacity="0.82" />
      <path d="m13 17.3.9 4.6 1.6-2.1z" fill="#fff" fillOpacity="0.6" />
    </>
  );
}

/** Mark + wordmark for the sidebar. */
export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark />
      <div className="leading-tight">
        <p className="text-[15px] font-semibold tracking-tight text-foreground">DAVID</p>
        <p className="text-[11px] text-muted-foreground">Applications on autopilot</p>
      </div>
    </div>
  );
}
