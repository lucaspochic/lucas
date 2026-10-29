import type { Metadata } from "next";
import { NewPartyPage } from "../../_tiers/party-new";

export const metadata: Metadata = { title: "Nouveau fournisseur" };

export default function NewSupplierPage() {
  return <NewPartyPage section="fournisseurs" />;
}
