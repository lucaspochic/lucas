import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { orNotFound, requireCompanyContext } from "@/server/http/session";
import { getThirdParty } from "@/server/services/third-parties";
import { partyHref } from "@/lib/party-sections";

/** Ancien lien de fiche : renvoie vers la rubrique Clients ou Fournisseurs selon le rôle. */
export default async function ThirdPartyRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requireCompanyContext();
  const party = await orNotFound(getThirdParty(await getDb(), ctx, id));
  redirect(partyHref(party));
}
