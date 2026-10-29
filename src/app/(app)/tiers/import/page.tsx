import type { Metadata } from "next";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { CsvImportForm } from "@/components/data/csv-import-form";
import { importThirdPartiesAction } from "@/app/actions/third-parties";
import { requirePermission } from "@/server/http/session";
import { THIRD_PARTY_CSV_HEADERS } from "@/server/services/third-parties";
import { isPartySection, SECTION_INFO } from "@/lib/party-sections";

export const metadata: Metadata = { title: "Importer des tiers" };

export default async function ImportThirdPartiesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const retour = (await searchParams).retour;
  const back = isPartySection(retour) ? retour : "clients";
  await requirePermission("thirdparties.write");
  return (
    <>
      <PageHeader title="Importer des clients et fournisseurs" description="Import contrôlé : si une seule ligne est invalide, rien n'est importé." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardBody>
            <CsvImportForm action={importThirdPartiesAction} backHref={`/${back}`} backLabel={`Voir les ${SECTION_INFO[back].title.toLowerCase()}`} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Format attendu" description="Première ligne : en-têtes. Ordre libre, colonnes facultatives sauf « type » et « nom »." />
          <CardBody className="space-y-3 text-[13px] text-foreground-muted">
            <p className="font-mono text-xs leading-relaxed text-foreground">{THIRD_PARTY_CSV_HEADERS.join(" ; ")}</p>
            <ul className="list-disc space-y-1 pl-4">
              <li>
                <span className="font-medium text-foreground">type</span> : particulier, professionnel ou organisme public
              </li>
              <li>
                <span className="font-medium text-foreground">client / fournisseur</span> : oui ou non (client par défaut)
              </li>
              <li>
                <span className="font-medium text-foreground">code</span> : laissé vide, il est attribué automatiquement
              </li>
              <li>Le fichier produit par « Exporter » peut être réimporté tel quel.</li>
            </ul>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
