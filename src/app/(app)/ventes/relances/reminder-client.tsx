"use client";

import { useState } from "react";
import { BellRing } from "lucide-react";
import { toast } from "sonner";
import { sendReminderAction } from "@/app/actions/reminders";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input, Select } from "@/components/ui/form-controls";

const LEVELS = { 1: "Relance amiable", 2: "Second rappel", 3: "Mise en demeure de payer" } as const;

export function ReminderButton({
  invoiceId,
  number,
  nextLevel,
  email,
  emailEnabled,
  mailto,
}: {
  invoiceId: string;
  number: string;
  nextLevel: 1 | 2 | 3;
  email: string | null;
  emailEnabled: boolean;
  mailto: string | null;
}) {
  const [level, setLevel] = useState<string>(String(nextLevel));
  const [channel, setChannel] = useState<"email" | "letter" | "other">(emailEnabled && email ? "email" : "letter");
  const [recipient, setRecipient] = useState(email ?? "");
  const letterHref = `/impression/relances/${invoiceId}?niveau=${level}`;

  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="secondary">
          <BellRing className="size-3.5" aria-hidden /> Relancer
        </Button>
      }
      title={`Relancer la facture ${number}`}
      description={
        <span className="block space-y-3 text-[13px]">
          <span className="grid grid-cols-2 gap-2">
            <Select aria-label="Niveau de relance" value={level} onChange={(e) => setLevel(e.target.value)}>
              {Object.entries(LEVELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {v}. {l}
                </option>
              ))}
            </Select>
            <Select aria-label="Canal" value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
              {emailEnabled && <option value="email">E-mail (facture jointe)</option>}
              <option value="letter">Courrier</option>
              <option value="other">Autre (messagerie, téléphone…)</option>
            </Select>
          </span>
          {channel === "email" && <Input aria-label="Adresse du destinataire" type="email" value={recipient} onChange={(e) => setRecipient(e.target.value)} />}
          <span className="flex flex-wrap gap-3">
            <a href={letterHref} target="_blank" rel="noopener" className="font-medium text-accent hover:underline">
              Voir / imprimer la lettre
            </a>
            {!emailEnabled && mailto && level === String(nextLevel) && (
              <a href={mailto} className="font-medium text-accent hover:underline">
                Ouvrir dans ma messagerie
              </a>
            )}
          </span>
          <span className="block text-xs text-foreground-muted">
            {channel === "email"
              ? "Le message est envoyé maintenant, puis enregistré dans l'historique."
              : "Envoyez la lettre ou le message, puis enregistrez la relance pour garder l'historique."}{" "}
            Relisez le texte avant l&apos;envoi : il s&apos;agit d&apos;un modèle.
          </span>
        </span>
      }
      confirmLabel={channel === "email" ? "Envoyer" : "Enregistrer la relance"}
      onConfirm={async () => {
        const r = await sendReminderAction(invoiceId, { level, channel, recipient: channel === "email" ? recipient : undefined });
        if (r.ok) toast.success(r.message);
        else toast.error(r.error);
        return r.ok;
      }}
    />
  );
}
