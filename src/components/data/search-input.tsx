"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";

/** Champ de recherche synchronisé avec le paramètre « q » de l'URL (délai de 300 ms). */
export function SearchInput({ placeholder }: { placeholder: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(searchParams.get("q") ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const push = (q: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (q) params.set("q", q);
    else params.delete("q");
    params.delete("page");
    router.replace(`${pathname}${params.size ? `?${params}` : ""}`);
  };

  return (
    <div className="relative w-full sm:w-72">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtle" aria-hidden />
      <input
        type="search"
        value={value}
        aria-label={placeholder}
        placeholder={placeholder}
        maxLength={100}
        onChange={(e) => {
          const q = e.target.value;
          setValue(q);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => push(q.trim()), 300);
        }}
        className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-8 text-sm placeholder:text-foreground-subtle focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          aria-label="Effacer la recherche"
          onClick={() => {
            setValue("");
            push("");
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-foreground-subtle hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
