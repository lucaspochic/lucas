import { Badge } from "@/components/ui/card";
import { todayInParis } from "@/server/domain/numbering";
import { formatDate } from "../ventes/sales-ui";

const INT = new Intl.NumberFormat("fr-FR");

export function meterLabel(value: number | null, unit: string | null): string {
  if (value === null) return "—";
  return `${INT.format(value)} ${unit === "h" ? "h" : "km"}`;
}

/** Garantie : en cours, bientôt échue (60 jours) ou échue. */
export function warrantyBadge(endsOn: string | null, today = todayInParis()) {
  if (!endsOn) return null;
  if (endsOn < today) return <Badge>Échue le {formatDate(endsOn)}</Badge>;
  const soon = new Date(`${today}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 60);
  const tone = endsOn <= soon.toISOString().slice(0, 10) ? "warning" : "success";
  return <Badge tone={tone}>Jusqu&apos;au {formatDate(endsOn)}</Badge>;
}
