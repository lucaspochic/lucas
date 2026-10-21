import type { Metadata } from "next";
import Link from "next/link";
import { BellRing, ChevronLeft } from "lucide-react";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { overdueInvoices, reminderPreview } from "@/server/services/reminders";
import { getMailTransport } from "@/server/email/transport";
import { REMINDER_LEVELS } from "@/server/domain/reminders";
import { dec, formatEuro } from "@/server/domain/money";
import { REMINDER_CHANNEL_LABELS } from "@/lib/schemas";
import { formatDate } from "../sales-ui";
import { ReminderButton } from "./reminder-client";

export const metadata: Metadata = { title: "Relances" };
export const dynamic = "force-dynamic";

export default async function RemindersPage() {
  const { ctx } = await requirePermission("sales.read");
  const db = await getDb();
  const rows = await overdueInvoices(db, ctx);
  const canWrite = can(ctx, "sales.write");
  const emailEnabled = getMailTransport() !== null;
  // Lettre du niveau suivant, pour l'ouverture dans la messagerie de l'utilisateur.
  const letters = canWrite ? await Promise.all(rows.map((r) => reminderPreview(db, ctx, r.id, r.nextLevel).then((p) => p.letter))) : [];
  const total = rows.reduce((a, r) => a.plus(r.remaining), dec("0"));

  return (
    <>
      <Link href="/ventes" className="mb-3 inline-flex items-center gap-1 text-[13px] text-foreground-muted hover:text-foreground">
        <ChevronLeft className="size-4" aria-hidden /> Devis & factures
      </Link>
      <PageHeader
        title="Relances"
        description={`Factures échues non réglées : ${rows.length} pour ${formatEuro(total)}. Chaque relance est enregistrée dans l'historique de la facture.`}
      />
      <Card>
        <CardHeader
          title="Factures à relancer"
          description={
            emailEnabled
              ? "Envoi par e-mail avec la facture en PDF, ou lettre à imprimer."
              : "L'envoi d'e-mails n'est pas configuré : ouvrez le message dans votre messagerie ou imprimez la lettre, puis enregistrez la relance."
          }
        />
        {rows.length === 0 ? (
          <EmptyState icon={<BellRing className="size-5" aria-hidden />} title="Aucune facture en retard" description="Les factures échues et non réglées apparaîtront ici." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-foreground-muted">
                  <th className="px-5 py-2.5 font-medium">Facture</th>
                  <th className="px-2 py-2.5 font-medium">Client</th>
                  <th className="px-2 py-2.5 font-medium">Échéance</th>
                  <th className="px-2 py-2.5 text-right font-medium">Reste dû</th>
                  <th className="px-2 py-2.5 font-medium">Dernière relance</th>
                  <th className="px-5 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id} className="border-b border-border last:border-0 align-middle">
                    <td className="px-5 py-2.5 font-mono text-xs">
                      <Link href={`/ventes/${r.id}`} className="hover:text-accent">
                        {r.number}
                      </Link>
                    </td>
                    <td className="px-2 py-2.5">{r.party.name}</td>
                    <td className="px-2 py-2.5">
                      {formatDate(r.dueDate!)}{" "}
                      <Badge tone={r.daysLate > 30 ? "danger" : "warning"}>
                        {r.daysLate} j de retard
                      </Badge>
                    </td>
                    <td className="tabular px-2 py-2.5 text-right font-medium">{formatEuro(r.remaining)}</td>
                    <td className="px-2 py-2.5 text-foreground-muted">
                      {r.lastReminder
                        ? `${REMINDER_LEVELS[r.lastReminder.level as 1 | 2 | 3]} · ${REMINDER_CHANNEL_LABELS[r.lastReminder.channel]} · ${r.lastReminder.sentAt.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" })}`
                        : "—"}
                    </td>
                    <td className="px-5 py-2.5 text-right">
                      {canWrite && (
                        <ReminderButton
                          invoiceId={r.id}
                          number={r.number}
                          nextLevel={r.nextLevel}
                          email={r.party.email}
                          emailEnabled={emailEnabled}
                          mailto={r.party.email ? `mailto:${r.party.email}?subject=${encodeURIComponent(letters[i]!.subject)}&body=${encodeURIComponent(letters[i]!.body)}` : null}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
