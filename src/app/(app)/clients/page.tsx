import type { Metadata } from "next";
import type { SearchParams } from "@/components/data/list-controls";
import { PartyListPage } from "../_tiers/party-list";

export const metadata: Metadata = { title: "Clients" };

export default async function ClientsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return <PartyListPage section="clients" params={await searchParams} />;
}
