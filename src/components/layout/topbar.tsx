"use client";

import { useTransition } from "react";
import Link from "next/link";
import { DropdownMenu } from "radix-ui";
import { Building2, Check, ChevronsUpDown, LogOut, Plus, ShieldCheck } from "lucide-react";
import { logoutAction } from "@/app/actions/auth";
import { switchCompanyAction } from "@/app/actions/company";
import { Logo } from "./logo";
import { toast } from "sonner";

interface Props {
  user: { fullName: string; email: string };
  activeCompany: { id: string; name: string; isDemo: boolean };
  companies: { id: string; name: string }[];
}

const menuContent =
  "z-50 min-w-56 rounded-lg border border-border bg-background p-1 shadow-popover";
const menuItem =
  "flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-foreground outline-none data-[highlighted]:bg-muted";

export function Topbar({ user, activeCompany, companies }: Props) {
  const [pending, startTransition] = useTransition();
  const initials = user.fullName
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const switchTo = (id: string) =>
    startTransition(async () => {
      const result = await switchCompanyAction(id);
      if (result && !result.ok) toast.error(result.error);
    });

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur sm:px-6">
      <div className="md:hidden">
        <Logo compact />
      </div>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium hover:bg-muted disabled:opacity-60"
          disabled={pending}
          aria-label="Changer d'entreprise"
        >
          <Building2 className="size-4 text-foreground-muted" aria-hidden />
          <span className="max-w-48 truncate">{activeCompany.name}</span>
          <ChevronsUpDown className="size-3.5 text-foreground-subtle" aria-hidden />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={6} className={menuContent}>
            <DropdownMenu.Label className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-foreground-subtle">
              Entreprises
            </DropdownMenu.Label>
            {companies.map((c) => (
              <DropdownMenu.Item key={c.id} className={menuItem} onSelect={() => c.id !== activeCompany.id && switchTo(c.id)}>
                <span className="flex-1 truncate">{c.name}</span>
                {c.id === activeCompany.id && <Check className="size-4 text-accent" aria-hidden />}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Item asChild className={menuItem}>
              <Link href="/onboarding">
                <Plus className="size-4" aria-hidden /> Nouvelle entreprise
              </Link>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <div className="flex-1" />

      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent hover:ring-2 hover:ring-accent/20"
          aria-label="Menu du compte"
        >
          {initials}
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} className={menuContent}>
            <div className="px-2 py-1.5">
              <p className="truncate text-[13px] font-medium">{user.fullName}</p>
              <p className="truncate text-xs text-foreground-muted">{user.email}</p>
            </div>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Item asChild className={menuItem}>
              <Link href="/parametres/securite">
                <ShieldCheck className="size-4" aria-hidden /> Sécurité du compte
              </Link>
            </DropdownMenu.Item>
            <DropdownMenu.Item className={menuItem} onSelect={() => startTransition(() => logoutAction())}>
              <LogOut className="size-4" aria-hidden /> Se déconnecter
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </header>
  );
}
