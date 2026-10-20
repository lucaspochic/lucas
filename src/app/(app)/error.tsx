"use client";

import { AlertTriangle } from "lucide-react";
import { Card, EmptyState } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/** Erreur inattendue : message générique, identifiant technique pour le support. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <Card>
      <EmptyState
        icon={<AlertTriangle className="size-5" aria-hidden />}
        title="Une erreur est survenue"
        description={`L'opération n'a pas pu aboutir. Si le problème persiste, communiquez cette référence au support : ${error.digest ?? "inconnue"}.`}
        action={
          <Button variant="secondary" onClick={reset}>
            Réessayer
          </Button>
        }
      />
    </Card>
  );
}
