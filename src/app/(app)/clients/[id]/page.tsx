import type { Metadata } from "next";
import { PartyDetailPage } from "../../_tiers/party-detail";

export const metadata: Metadata = { title: "Fiche client" };

export default async function ClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  return <PartyDetailPage section="clients" id={id} created={(await searchParams).cree === "1"} />;
}
