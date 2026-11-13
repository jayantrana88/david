import { useSearchParams } from "react-router-dom";

export type Range = { from?: string; to?: string };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (v: string | null): v is string => !!v && DAY.test(v) && !Number.isNaN(Date.parse(v));

/** A page's `?q=&page=&from=&to=` plus any named filter, read from the address (junk dates are ignored). */
export function useListQuery(filterParam?: string) {
  const [sp] = useSearchParams();
  let from = validDay(sp.get("from")) ? sp.get("from")! : undefined;
  let to = validDay(sp.get("to")) ? sp.get("to")! : undefined;
  if (from && to && from > to) [from, to] = [to, from];
  return {
    filter: filterParam ? sp.get(filterParam) || undefined : undefined,
    q: sp.get("q") || undefined,
    page: Math.max(1, Number(sp.get("page")) || 1),
    range: { from, to } as Range,
    dated: Boolean(from || to),
  };
}

/** `?a=1&b=2` from the defined, non-empty values ("" when there are none). */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}
