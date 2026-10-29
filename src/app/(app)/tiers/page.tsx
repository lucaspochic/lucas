import { redirect } from "next/navigation";

/** Ancienne rubrique « Clients & fournisseurs », désormais scindée. */
export default function ThirdPartiesPage() {
  redirect("/clients");
}
