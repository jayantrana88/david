
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTheme } from "next-themes";

/** `/` focuses the page's search box, `n` opens New task, `t` switches light/dark. Ignored while typing. */
export function Shortcuts() {
  const navigate = useNavigate();
  const { resolvedTheme, setTheme } = useTheme();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === "/") {
        const search = document.getElementById("search") as HTMLInputElement | null;
        if (search) {
          e.preventDefault();
          search.focus();
          search.select();
        }
      } else if (e.key === "n") {
        navigate("/tasks/new");
      } else if (e.key === "t") {
        setTheme(resolvedTheme === "dark" ? "light" : "dark");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, resolvedTheme, setTheme]);
  return null;
}
