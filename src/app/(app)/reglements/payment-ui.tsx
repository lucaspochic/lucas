import { Badge } from "@/components/ui/card";
import type { InvoiceStatus } from "@/server/services/payments";

export const PAYMENT_KIND_LABELS = { receipt: "Encaissement", refund: "Remboursement", reversal: "Contre-passation" } as const;

const STATUS: Record<InvoiceStatus, { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  unpaid: { label: "Non réglée", tone: "neutral" },
  partial: { label: "Partiellement réglée", tone: "accent" },
  paid: { label: "Réglée", tone: "success" },
  overdue: { label: "En retard", tone: "danger" },
  overpaid: { label: "Trop-perçu", tone: "warning" },
};

export function PaymentStatusBadge({ status }: { status: InvoiceStatus }) {
  return <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>;
}

export function KindBadge({ kind }: { kind: keyof typeof PAYMENT_KIND_LABELS }) {
  const tone = kind === "receipt" ? "success" : kind === "refund" ? "warning" : "danger";
  return <Badge tone={tone}>{PAYMENT_KIND_LABELS[kind]}</Badge>;
}
