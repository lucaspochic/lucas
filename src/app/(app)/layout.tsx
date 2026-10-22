import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { getCompany, listUserCompanies } from "@/server/services/companies";
import { MobileNav, Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { can } from "@/server/security/permissions";
import { navigationModules } from "@/server/services/modules";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { session, ctx } = await requireCompanyContext();
  const db = await getDb();
  const [company, companies] = await Promise.all([getCompany(db, ctx), listUserCompanies(db, session.userId)]);
  const { visible, featured } = await navigationModules(db, company);
  const nav = { canSeeAudit: can(ctx, "audit.read"), canManageMembers: can(ctx, "members.read"), modules: visible, featured };

  return (
    <div className="flex min-h-screen">
      <Sidebar {...nav} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          user={{ fullName: session.fullName, email: session.email }}
          activeCompany={{ id: company.id, name: company.tradeName || company.legalName, isDemo: company.isDemo }}
          companies={companies.map((c) => ({ id: c.id, name: c.tradeName || c.legalName }))}
        />
        <MobileNav {...nav} />
        {company.isDemo && (
          <div className="border-b border-warning/20 bg-warning-soft px-6 py-1.5 text-center text-xs font-medium text-warning">
            Entreprise de démonstration — données fictives, sans valeur légale ni comptable
          </div>
        )}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-8 sm:py-8">{children}</main>
      </div>
    </div>
  );
}
