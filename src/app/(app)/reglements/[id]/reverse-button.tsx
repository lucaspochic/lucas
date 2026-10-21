"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { toast } from "sonner";
import { reversePaymentAction } from "@/app/actions/payments";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Textarea } from "@/components/ui/form-controls";

export function ReverseButton({ id, number }: { id: string; number: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  return (
    <ConfirmDialog
      trigger={
        <Button variant="secondary">
          <Undo2 className="size-4" aria-hidden /> Contre-passer
        </Button>
      }
      title={`Contre-passer le règlement ${number} ?`}
      description={
        <span className="block space-y-3">
          <span className="block">
            Une écriture de montant opposé est enregistrée et les factures concernées retrouvent leur reste à payer. Le règlement
            d&apos;origine reste visible : rien n&apos;est effacé.
          </span>
          <label className="block text-[13px] font-medium text-foreground" htmlFor="reason">
            Motif (obligatoire)
          </label>
          <Textarea
            id="reason"
            rows={2}
            value={reason}
            aria-invalid={!!error}
            onChange={(e) => {
              setReason(e.target.value);
              setError(null);
            }}
            placeholder="Ex. saisi sur le mauvais client"
          />
          {error && (
            <span role="alert" className="block text-xs text-danger">
              {error}
            </span>
          )}
        </span>
      }
      confirmLabel="Contre-passer"
      tone="danger"
      onConfirm={async () => {
        const r = await reversePaymentAction(id, { idempotencyKey, reason });
        if (!r.ok) {
          setError(r.fieldErrors?.reason ?? r.error);
          return false;
        }
        toast.success(r.message);
        router.push(`/reglements/${r.data!.id}`);
      }}
    />
  );
}
