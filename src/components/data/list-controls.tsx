import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type SearchParams = Record<string, string | string[] | undefined>;

/** Construit une URL de liste en conservant les paramètres courants. */
export function listHref(base: string, current: SearchParams, overrides: Record<string, string | number | null>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (value) params.set(k, value);
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null || v === "") params.delete(k);
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function SortHeader({
  base,
  params,
  column,
  label,
  activeSort,
  dir,
  className,
}: {
  base: string;
  params: SearchParams;
  column: string;
  label: string;
  activeSort: string;
  dir: "asc" | "desc";
  className?: string;
}) {
  const active = activeSort === column;
  const nextDir = active && dir === "asc" ? "desc" : "asc";
  const Icon = dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className={cn("px-5 py-2.5 font-medium", className)} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <Link
        href={listHref(base, params, { tri: column, ordre: nextDir, page: null })}
        className={cn("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")}
      >
        {label}
        {active && <Icon className="size-3" aria-hidden />}
      </Link>
    </th>
  );
}

export function Pagination({
  base,
  params,
  page,
  total,
  pageSize,
}: {
  base: string;
  params: SearchParams;
  page: number;
  total: number;
  pageSize: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const btn = "inline-flex size-8 items-center justify-center rounded-md border border-border hover:bg-muted";
  return (
    <div className="flex items-center justify-between border-t border-border px-5 py-3 text-[13px] text-foreground-muted">
      <span className="tabular">
        {from}–{to} sur {total}
      </span>
      {pages > 1 && (
        <div className="flex items-center gap-1">
          {page > 1 ? (
            <Link href={listHref(base, params, { page: page - 1 })} className={btn} aria-label="Page précédente">
              <ChevronLeft className="size-4" />
            </Link>
          ) : (
            <span className={cn(btn, "opacity-40")} aria-hidden>
              <ChevronLeft className="size-4" />
            </span>
          )}
          <span className="tabular px-2">
            {page} / {pages}
          </span>
          {page < pages ? (
            <Link href={listHref(base, params, { page: page + 1 })} className={btn} aria-label="Page suivante">
              <ChevronRight className="size-4" />
            </Link>
          ) : (
            <span className={cn(btn, "opacity-40")} aria-hidden>
              <ChevronRight className="size-4" />
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function FilterTabs({
  base,
  params,
  name,
  options,
  value,
}: {
  base: string;
  params: SearchParams;
  name: string;
  options: { value: string; label: string }[];
  value: string;
}) {
  return (
    <div className="flex rounded-md border border-border bg-background p-0.5 text-[13px]" role="tablist">
      {options.map((o) => (
        <Link
          key={o.value}
          role="tab"
          aria-selected={o.value === value}
          href={listHref(base, params, { [name]: o.value || null, page: null })}
          className={cn(
            "rounded px-2.5 py-1 font-medium",
            o.value === value ? "bg-muted text-foreground" : "text-foreground-muted hover:text-foreground",
          )}
        >
          {o.label}
        </Link>
      ))}
    </div>
  );
}
