import type { Metadata } from "next";
import type { SearchParams } from "@/components/data/list-controls";
import { PartyListPage } from "../_tiers/party-list";

export const metadata: Metadata = { title: "Fournisseurs" };

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return <PartyListPage section="fournisseurs" params={await searchParams} />;
}
