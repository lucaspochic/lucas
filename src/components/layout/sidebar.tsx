"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Banknote,
  BookOpen,
  Building2,
  FileText,
  LayoutDashboard,
  Package,
  ScrollText,
  ShieldCheck,
  Store,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Module non encore livré : affiché mais inactif, pour rendre la feuille de route visible. */
  upcoming?: boolean;
}

interface NavProps {
  canSeeAudit: boolean;
  canManageMembers: boolean;
}

function navSections({ canSeeAudit, canManageMembers }: NavProps) {
  const main: NavItem[] = [
    { href: "/tableau-de-bord", label: "Tableau de bord", icon: LayoutDashboard },
    { href: "/tiers", label: "Clients & fournisseurs", icon: Users },
    { href: "/catalogue", label: "Produits & services", icon: Package },
    { href: "/ventes", label: "Devis & factures", icon: FileText },
    { href: "/reglements", label: "Règlements", icon: Banknote },
    { href: "#tresorerie", label: "Trésorerie", icon: Wallet, upcoming: true },
    { href: "#comptabilite", label: "Comptabilité", icon: BookOpen, upcoming: true },
    { href: "#caisse", label: "Caisse", icon: Store, upcoming: true },
  ];
  const settings: NavItem[] = [
    { href: "/parametres/entreprise", label: "Entreprise", icon: Building2 },
    ...(canManageMembers ? [{ href: "/parametres/utilisateurs", label: "Utilisateurs", icon: Users }] : []),
    { href: "/parametres/securite", label: "Sécurité", icon: ShieldCheck },
    ...(canSeeAudit ? [{ href: "/journal", label: "Journal d'audit", icon: ScrollText }] : []),
  ];
  return { main, settings };
}

/** Navigation compacte pour mobile (la barre latérale est masquée sous 768 px). */
export function MobileNav(props: NavProps) {
  const pathname = usePathname();
  const { main, settings } = navSections(props);
  const items = [...main, ...settings].filter((i) => !i.upcoming);
  return (
    <nav aria-label="Navigation" className="flex gap-1 overflow-x-auto border-b border-border bg-background px-3 py-2 md:hidden">
      {items.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium",
              active ? "bg-accent-soft text-accent" : "text-foreground-muted",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function Sidebar(props: NavProps) {
  const pathname = usePathname();
  const { main, settings } = navSections(props);

  const renderItem = (item: NavItem) => {
    const active = !item.upcoming && pathname.startsWith(item.href);
    const Icon = item.icon;
    if (item.upcoming) {
      return (
        <li key={item.href}>
          <span
            className="flex cursor-not-allowed items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] text-foreground-subtle"
            title="Module en cours de développement"
            aria-disabled="true"
          >
            <Icon className="size-4" aria-hidden />
            <span className="flex-1 truncate">{item.label}</span>
            <span className="rounded bg-muted px-1.5 text-[10px] font-medium uppercase tracking-wide">bientôt</span>
          </span>
        </li>
      );
    }
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors",
            active ? "bg-accent-soft text-accent" : "text-foreground-muted hover:bg-muted hover:text-foreground",
          )}
        >
          <Icon className="size-4" aria-hidden />
          <span className="truncate">{item.label}</span>
        </Link>
      </li>
    );
  };

  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-background px-3 py-4 md:flex">
      <div className="px-2.5 pb-6">
        <Logo />
      </div>
      <nav aria-label="Navigation principale" className="flex-1 space-y-6 overflow-y-auto">
        <ul className="space-y-0.5">{main.map(renderItem)}</ul>
        <div>
          <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-foreground-subtle">Paramètres</p>
          <ul className="space-y-0.5">{settings.map(renderItem)}</ul>
        </div>
      </nav>
    </aside>
  );
}
