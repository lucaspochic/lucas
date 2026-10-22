"use client";

import type { UseFormRegisterReturn } from "react-hook-form";
import { ACTIVITIES, ACTIVITY_INFO, MODULE_INFO } from "@/lib/activities";

/**
 * Cases à cocher des domaines d'activité (plusieurs choix possibles).
 * Chaque domaine indique le module qu'il active, pour que l'effet du choix soit visible.
 */
export function ActivitiesPicker({
  registration,
  columns = 1,
  initial = [],
}: {
  registration: UseFormRegisterReturn;
  columns?: 1 | 2;
  /** Cases cochées dès le rendu serveur (avant hydratation). */
  initial?: readonly string[];
}) {
  return (
    <div className={columns === 2 ? "grid gap-2 sm:grid-cols-2" : "grid gap-2"}>
      {ACTIVITIES.map((a) => {
        const info = ACTIVITY_INFO[a];
        return (
          <label
            key={a}
            className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2 text-[13px] has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
          >
            <input type="checkbox" value={a} defaultChecked={initial.includes(a)} className="mt-0.5 size-4 shrink-0 rounded border-border accent-[var(--color-accent)]" {...registration} />
            <span className="min-w-0">
              <span className="block font-medium text-foreground">{info.label}</span>
              <span className="block text-xs text-foreground-muted">
                {info.hint}
                {info.modules.length > 0 && <> · active {info.modules.map((m) => MODULE_INFO[m].label).join(", ")}</>}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
