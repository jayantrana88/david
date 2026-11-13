
import Link from "@/components/link";
import { useLocation } from "react-router-dom";
import {
  FileText,
  Globe,
  LayoutGrid,
  ListChecks,
  Mail,
  ScrollText,
  Plus,
  ScanSearch,
  Settings,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession } from "@/components/session";
import { Logo, LogoMark } from "./logo";
import { ThemeToggle, ThemeToggleButton } from "./theme-toggle";

type Item = { href: string; label: string; icon: LucideIcon; exact?: boolean; badge?: React.ReactNode };

const SECTIONS: { label?: string; items: Item[] }[] = [
  { items: [{ href: "/", label: "Overview", icon: LayoutGrid, exact: true }] },
  {
    label: "Inputs",
    items: [
      { href: "/profile", label: "Profile", icon: UserRound, exact: true },
      { href: "/tasks", label: "Tasks", icon: ListChecks },
    ],
  },
  {
    label: "Data",
    items: [
      { href: "/websites", label: "Companies", icon: Globe },
      { href: "/scrapes", label: "Fit checks", icon: ScanSearch },
      { href: "/pages", label: "Pages", icon: FileText },
      { href: "/emails", label: "Applications", icon: Mail },
    ],
  },
  { label: "System", items: [{ href: "/settings", label: "Settings", icon: Settings }] },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border bg-card px-1 font-sans text-[10.5px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

const LOGS: Item = { href: "/logs", label: "Logs", icon: ScrollText };

export function Sidebar() {
  const { pathname } = useLocation();
  const { worker } = useSession();
  const sections = SECTIONS.map((s) => (s.label === "System" && worker ? { ...s, items: [LOGS, ...s.items] } : s));
  // "Tasks" covers its list, not the New task page (that has its own button).
  const isActive = (item: Item) =>
    item.exact ? pathname === item.href : pathname.startsWith(item.href) && pathname !== "/tasks/new";
  const onNewTask = pathname === "/tasks/new";

  return (
    <aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col border-r bg-card/80 backdrop-blur-sm lg:flex">
      <div className="flex h-16 items-center px-5">
        <Link href="/" aria-label="Overview">
          <Logo />
        </Link>
      </div>

      <div className="px-3 pt-1 pb-3">
        <Link
          href="/tasks/new"
          className={cn(
            "group flex h-9 items-center gap-2 rounded-lg bg-gradient-to-r from-indigo-500 to-violet-600 px-3 text-[13.5px] font-medium text-white shadow-[0_4px_14px_-4px_rgba(99,102,241,0.55)] transition-all hover:brightness-110 active:translate-y-px",
            onNewTask && "ring-2 ring-brand-ring ring-offset-2 ring-offset-card",
          )}
        >
          <Plus className="size-4" />
          <span className="flex-1">New task</span>
          <kbd className="rounded bg-white/20 px-1.5 font-sans text-[10.5px] font-medium">N</kbd>
        </Link>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-2">
        {sections.map((section, i) => (
          <div key={i}>
            {section.label && (
              <p className="mb-1.5 px-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground/70 uppercase">
                {section.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = isActive(item);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "relative flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium transition-colors",
                        active
                          ? "bg-brand-soft text-brand before:absolute before:top-2 before:bottom-2 before:-left-3 before:w-[3px] before:rounded-r-full before:bg-brand"
                          : "text-secondary-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      <item.icon
                        className={cn("size-[18px] transition-colors", active ? "text-brand" : "text-muted-foreground")}
                      />
                      <span className="flex-1">{item.label}</span>
                      {item.badge}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="space-y-3 border-t px-3 py-3">
        <ThemeToggle />
        <p className="flex flex-wrap items-center justify-between gap-y-1 px-1 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Kbd>N</Kbd> new
          </span>
          <span className="flex items-center gap-1">
            <Kbd>/</Kbd> search
          </span>
          <span className="flex items-center gap-1">
            <Kbd>T</Kbd> theme
          </span>
        </p>
      </div>
    </aside>
  );
}

/** Top bar for small screens, where the sidebar is hidden. */
export function MobileNav() {
  const { pathname } = useLocation();
  const { worker } = useSession();
  const items = [
    ["/", "Overview"],
    ["/profile", "Profile"],
    ["/tasks/new", "New task"],
    ["/tasks", "Tasks"],
    ["/websites", "Companies"],
    ["/scrapes", "Fit checks"],
    ["/pages", "Pages"],
    ["/emails", "Applications"],
    ...(worker ? [["/logs", "Logs"]] : []),
    ["/settings", "Settings"],
  ];
  const isActive = (href: string) =>
    href === "/" || href === "/tasks/new"
      ? pathname === href
      : pathname.startsWith(href) && pathname !== "/tasks/new";
  return (
    <header className="sticky top-0 z-20 border-b bg-card/90 backdrop-blur-sm lg:hidden">
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <Link href="/" className="flex items-center gap-2">
          <LogoMark size={28} />
          <span className="text-[15px] font-semibold tracking-tight">DAVID</span>
        </Link>
        <ThemeToggleButton />
      </div>
      <nav className="flex gap-1 overflow-x-auto px-4 py-2">
        {items.map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "shrink-0 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
              isActive(href) ? "bg-brand-soft text-brand" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
