import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, Circle, FileText } from "lucide-react";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { getCompany } from "@/server/services/companies";
import { companySetupChecklist } from "@/server/services/company-setup";

export const metadata: Metadata = { title: "Tableau de bord" };

export default async function DashboardPage() {
  const { session, ctx } = await requireCompanyContext();
  const company = await getCompany(await getDb(), ctx);
  const checklist = companySetupChecklist(company);
  const done = checklist.filter((c) => c.done).length;

  return (
    <>
      <PageHeader title={`Bonjour ${session.fullName.split(" ")[0]}`} description={company.tradeName || company.legalName} />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Activité" description="Chiffre d'affaires, encaissements, créances et TVA estimée." />
          <EmptyState
            icon={<FileText className="size-5" aria-hidden />}
            title="Aucune donnée d'activité"
            description="Les indicateurs seront calculés à partir de vos factures et encaissements réels dès que le module de facturation sera disponible. Aucun chiffre n'est affiché tant qu'il n'existe pas de donnée."
          />
        </Card>

        {done < checklist.length && (
          <Card>
            <CardHeader title="Configuration" description={`${done} / ${checklist.length} étapes complétées`} />
            <CardBody className="space-y-1 py-3">
              {checklist.map((item) => (
                <Link
                  key={item.key}
                  href={item.href}
                  className="flex items-start gap-2.5 rounded-md px-2 py-2 text-[13px] hover:bg-muted"
                >
                  {item.done ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Fait" />
                  ) : (
                    <Circle className="mt-0.5 size-4 shrink-0 text-foreground-subtle" aria-label="À faire" />
                  )}
                  <span className={item.done ? "text-foreground-muted line-through" : "text-foreground"}>{item.label}</span>
                </Link>
              ))}
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
