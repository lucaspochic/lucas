import { Badge } from "@/components/ui/card";
import { DOCUMENT_STATUS_LABELS } from "@/server/domain/sales";

const TONES = { draft: "neutral", issued: "accent", accepted: "success", refused: "danger" } as const;

export function StatusBadge({ status }: { status: keyof typeof DOCUMENT_STATUS_LABELS }) {
  return <Badge tone={TONES[status]}>{DOCUMENT_STATUS_LABELS[status]}</Badge>;
}

/** « 2026-10-20 » → « 20/10/2026 ». */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
