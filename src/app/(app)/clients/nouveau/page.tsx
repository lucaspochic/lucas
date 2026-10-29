import type { Metadata } from "next";
import { NewPartyPage } from "../../_tiers/party-new";

export const metadata: Metadata = { title: "Nouveau client" };

export default function NewClientPage() {
  return <NewPartyPage section="clients" />;
}
