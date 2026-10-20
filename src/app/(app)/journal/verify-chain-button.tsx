"use client";

import { useTransition } from "react";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { verifyAuditAction } from "@/app/actions/company";
import { Button } from "@/components/ui/button";

export function VerifyChainButton() {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="secondary"
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await verifyAuditAction();
          if (!result.ok) return void toast.error(result.error);
          const v = result.data!;
          if (v.valid) {
            toast.success(`Chaîne intègre : ${v.eventsChecked} événement(s) vérifié(s).`, {
              description: `Empreinte de tête : ${v.headHash.slice(0, 16)}…`,
            });
          } else {
            toast.error(`Altération détectée à l'événement n° ${v.firstError?.chainSeq}`, {
              description: v.firstError?.reason,
              duration: Infinity,
            });
          }
        })
      }
    >
      {!pending && <ShieldCheck className="size-4" aria-hidden />}
      Vérifier l&apos;intégrité
    </Button>
  );
}
