import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/http/session";
import { getCompany } from "@/server/services/companies";
import { ThirdPartyForm } from "../third-party-form";

export const metadata: Metadata = { title: "Nouveau tiers" };

export default async function NewThirdPartyPage() {
  const { ctx } = await requirePermission("thirdparties.write");
  const company = await getCompany(await getDb(), ctx);
  return (
    <>
      <PageHeader title="Nouveau client ou fournisseur" />
      <ThirdPartyForm
        defaultTermsDays={company.paymentTermsDays}
        defaults={{
          partyType: "individual",
          isCustomer: true,
          isSupplier: false,
          name: "",
          billingCountry: "FR",
          hasShippingAddress: false,
        }}
      />
    </>
  );
}
