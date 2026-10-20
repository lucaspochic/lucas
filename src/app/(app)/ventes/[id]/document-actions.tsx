"use client";

import { useState, useTransition } from "react";
import { Check, FileMinus, FileOutput, Printer, Send, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import {
  convertQuoteAction,
  createCreditNoteAction,
  deleteSalesDraftAction,
  issueSalesDocumentAction,
  respondToQuoteAction,
} from "@/app/actions/sales";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

type DocType = "quote" | "invoice" | "credit_note";
const NAMES: Record<DocType, string> = { quote: "le devis", invoice: "la facture", credit_note: "l'avoir" };

export function DraftActions({ id, type, canIssue, canWrite }: { id: string; type: DocType; canIssue: boolean; canWrite: boolean }) {
  const [warnings, setWarnings] = useState<string | null>(null);
  const issue = async (acceptWarnings: boolean) => {
    const r = await issueSalesDocumentAction(id, acceptWarnings);
    if (!r.ok) {
      toast.error(r.error, { duration: 10000 });
      return false;
    }
    if (r.data?.warnings) {
      setWarnings(r.data.warnings);
      return false;
    }
    toast.success(r.message);
    setWarnings(null);
  };

  return (
    <>
      {canWrite && (
        <ConfirmDialog
          trigger={
            <Button variant="ghost">
              <Trash2 className="size-4" aria-hidden /> Supprimer
            </Button>
          }
          title="Supprimer ce brouillon ?"
          description="Un brouillon n'a pas de numéro : sa suppression ne crée aucun trou dans la numérotation. Elle est tracée dans le journal d'audit."
          confirmLabel="Supprimer"
          tone="danger"
          onConfirm={async () => {
            const r = await deleteSalesDraftAction(id);
            if (r && !r.ok) toast.error(r.error);
          }}
        />
      )}
      {canIssue && (
        <ConfirmDialog
          trigger={
            <Button>
              <Send className="size-4" aria-hidden /> Émettre
            </Button>
          }
          title={`Émettre ${NAMES[type]} ?`}
          description={
            warnings ? (
              <span className="block space-y-2">
                <span className="block rounded-md bg-warning-soft px-3 py-2 text-warning">{warnings}</span>
                <span className="block">Confirmez-vous l&apos;émission malgré ces points ?</span>
              </span>
            ) : (
              <>
                Le document recevra un numéro définitif et la date du jour. Il ne pourra plus être modifié ni supprimé
                {type === "invoice" ? " : toute correction passera par un avoir." : "."}
              </>
            )
          }
          confirmLabel={warnings ? "Émettre malgré tout" : "Émettre"}
          onConfirm={() => issue(warnings !== null)}
        />
      )}
    </>
  );
}

export function IssuedActions({
  id,
  type,
  status,
  canWrite,
  hasInvoice,
}: {
  id: string;
  type: DocType;
  status: string;
  canWrite: boolean;
  hasInvoice: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string } | undefined | void>) =>
    startTransition(async () => {
      const r = await fn();
      if (r && !r.ok && r.error) toast.error(r.error);
      else if (r && r.ok && r.message) toast.success(r.message);
    });

  return (
    <>
      <a
        href={`/impression/ventes/${id}`}
        target="_blank"
        rel="noopener"
        className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background px-4 text-sm font-medium hover:bg-muted"
      >
        <Printer className="size-4" aria-hidden /> Imprimer / PDF
      </a>
      {canWrite && type === "quote" && status === "issued" && (
        <>
          <Button variant="secondary" disabled={pending} onClick={() => run(() => respondToQuoteAction(id, "refused"))}>
            <X className="size-4" aria-hidden /> Refusé
          </Button>
          <Button variant="secondary" disabled={pending} onClick={() => run(() => respondToQuoteAction(id, "accepted"))}>
            <Check className="size-4" aria-hidden /> Accepté
          </Button>
        </>
      )}
      {canWrite && type === "quote" && (status === "issued" || status === "accepted") && (
        <Button disabled={pending} onClick={() => run(() => convertQuoteAction(id))}>
          <FileOutput className="size-4" aria-hidden /> {hasInvoice ? "Voir la facture" : "Facturer"}
        </Button>
      )}
      {canWrite && type === "invoice" && (
        <ConfirmDialog
          trigger={
            <Button variant="secondary">
              <FileMinus className="size-4" aria-hidden /> Établir un avoir
            </Button>
          }
          title="Établir un avoir sur cette facture ?"
          description="Un brouillon d'avoir reprenant toutes les lignes est créé. Modifiez-le pour un avoir partiel, puis émettez-le. Le cumul des avoirs ne peut pas dépasser le montant de la facture."
          confirmLabel="Créer le brouillon d'avoir"
          onConfirm={async () => {
            const r = await createCreditNoteAction(id);
            if (r && !r.ok) toast.error(r.error);
          }}
        />
      )}
    </>
  );
}
