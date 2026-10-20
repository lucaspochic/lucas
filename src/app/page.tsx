import { redirect } from "next/navigation";
import { getSession } from "@/server/http/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();
  redirect(session ? "/tableau-de-bord" : "/login");
}
