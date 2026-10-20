import type { Metadata } from "next";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { CsvImportForm } from "@/components/data/csv-import-form";
import { importProductsAction } from "@/app/actions/products";
import { requirePermission } from "@/server/http/session";
import { PRODUCT_CSV_HEADERS } from "@/server/services/products";
import { UNITS } from "@/lib/schemas";

export const metadata: Metadata = { title: "Importer le catalogue" };

export default async function ImportProductsPage() {
  await requirePermission("catalog.write");
  return (
    <>
      <PageHeader title="Importer des articles" description="Import contrôlé : si une seule ligne est invalide, rien n'est importé." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardBody>
            <CsvImportForm action={importProductsAction} backHref="/catalogue" backLabel="Voir le catalogue" />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Format attendu" description="Première ligne : en-têtes. Colonnes obligatoires : référence, désignation, nature, unité, prix de vente HT, taux de TVA." />
          <CardBody className="space-y-3 text-[13px] text-foreground-muted">
            <p className="font-mono text-xs leading-relaxed text-foreground">{PRODUCT_CSV_HEADERS.join(" ; ")}</p>
            <ul className="list-disc space-y-1 pl-4">
              <li>
                <span className="font-medium text-foreground">nature</span> : bien ou service
              </li>
              <li>
                <span className="font-medium text-foreground">unite</span> : {UNITS.join(", ")}
              </li>
              <li>Prix et taux acceptés avec virgule ou point (« 12,50 », « 5,5 »).</li>
              <li>Le taux doit correspondre à un taux actif de l&apos;entreprise.</li>
            </ul>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
