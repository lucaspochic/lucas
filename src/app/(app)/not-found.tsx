import Link from "next/link";
import { SearchX } from "lucide-react";
import { Card, EmptyState } from "@/components/ui/card";

export default function NotFound() {
  return (
    <Card>
      <EmptyState
        icon={<SearchX className="size-5" aria-hidden />}
        title="Page introuvable"
        description="Cet élément n'existe pas, a été déplacé, ou vous n'avez pas les droits pour le consulter."
        action={
          <Link href="/tableau-de-bord" className="text-sm font-medium text-accent hover:underline">
            Retour au tableau de bord
          </Link>
        }
      />
    </Card>
  );
}
