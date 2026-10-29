import { PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/http/session";
import { getCompany } from "@/server/services/companies";
import { SECTION_INFO, type PartySection } from "@/lib/party-sections";
import { ThirdPartyForm } from "./third-party-form";

/** Création d'une fiche : rôle et type pré-remplis selon la rubrique (modifiables). */
export async function NewPartyPage({ section }: { section: PartySection }) {
  const { ctx } = await requirePermission("thirdparties.write");
  const company = await getCompany(await getDb(), ctx);
  const isCustomer = section === "clients";
  return (
    <>
      <PageHeader title={SECTION_INFO[section].newTitle} />
      <ThirdPartyForm
        section={section}
        defaultTermsDays={company.paymentTermsDays}
        defaults={{
          partyType: isCustomer ? "individual" : "business",
          isCustomer,
          isSupplier: !isCustomer,
          name: "",
          billingCountry: "FR",
          hasShippingAddress: false,
        }}
      />
    </>
  );
}
