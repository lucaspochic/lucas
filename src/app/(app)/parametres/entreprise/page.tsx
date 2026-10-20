import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { getCompany, listVatRates } from "@/server/services/companies";
import { can } from "@/server/security/permissions";
import { CompanyForm } from "./company-form";

export const metadata: Metadata = { title: "Entreprise" };

export default async function CompanySettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { ctx } = await requireCompanyContext();
  const db = await getDb();
  const [company, rates] = await Promise.all([getCompany(db, ctx), listVatRates(db, ctx)]);
  const welcome = (await searchParams).bienvenue === "1";

  return (
    <>
      <PageHeader
        title="Entreprise"
        description={
          welcome
            ? "Entreprise créée. Complétez ces informations : elles figureront sur vos factures."
            : "Identité, mentions légales, fiscalité et numérotation des documents."
        }
      />
      <CompanyForm
        readOnly={!can(ctx, "company.update")}
        vatRates={rates.map((r) => ({ id: r.id, label: r.label, rate: r.rate, exemptionReason: r.exemptionReason }))}
        defaults={{
          legalName: company.legalName,
          tradeName: company.tradeName ?? "",
          legalForm: company.legalForm ?? "",
          siren: company.siren ?? "",
          siret: company.siret ?? "",
          vatNumber: company.vatNumber ?? "",
          nafCode: company.nafCode ?? "",
          shareCapital: company.shareCapital ?? "",
          rcsCity: company.rcsCity ?? "",
          addressLine1: company.addressLine1 ?? "",
          addressLine2: company.addressLine2 ?? "",
          postalCode: company.postalCode ?? "",
          city: company.city ?? "",
          country: company.country,
          email: company.email ?? "",
          phone: company.phone ?? "",
          website: company.website ?? "",
          iban: company.iban ?? "",
          bic: company.bic ?? "",
          fiscalYearStartMonth: company.fiscalYearStartMonth,
          vatRegime: company.vatRegime,
          vatOnDebits: company.vatOnDebits,
          paymentTermsDays: company.paymentTermsDays,
          latePenaltyText: company.latePenaltyText ?? "",
          legalMentions: company.legalMentions ?? "",
          invoicePrefix: company.invoicePrefix,
          creditNotePrefix: company.creditNotePrefix,
          quotePrefix: company.quotePrefix,
        }}
      />
    </>
  );
}
