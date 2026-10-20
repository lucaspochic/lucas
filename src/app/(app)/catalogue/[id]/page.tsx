import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Badge, PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { orNotFound, requireCompanyContext } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { listVatRates } from "@/server/services/companies";
import { getProduct } from "@/server/services/products";
import { formatDateTime } from "@/lib/utils";
import { UNITS } from "@/lib/schemas";
import { ProductForm } from "../product-form";
import { ArchiveProductButton } from "./archive-product-button";

export const metadata: Metadata = { title: "Article" };

/** « 12.5000 » → « 12,50 » pour l'édition (2 décimales minimum, 4 au maximum). */
function editablePrice(v: string): string {
  const [i, f = ""] = v.split(".");
  const trimmed = f.replace(/0+$/, "");
  return `${i},${trimmed.padEnd(2, "0")}`;
}

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const created = (await searchParams).cree === "1";
  const { ctx } = await requireCompanyContext();
  const db = await getDb();
  const [product, rates] = await Promise.all([orNotFound(getProduct(db, ctx, id)), listVatRates(db, ctx)]);
  const canWrite = can(ctx, "catalog.write");
  const archived = !!product.archivedAt;
  // Le taux actuel reste proposé même s'il a été désactivé depuis.
  const options = rates.filter((r) => r.active || r.id === product.vatRateId);

  return (
    <>
      <Link href="/catalogue" className="mb-3 inline-flex items-center gap-1 text-[13px] text-foreground-muted hover:text-foreground">
        <ChevronLeft className="size-4" aria-hidden /> Produits & services
      </Link>
      <PageHeader
        title={product.name}
        description={`${product.reference} · créé le ${formatDateTime(product.createdAt)}`}
        actions={
          <>
            {archived && <Badge tone="warning">Archivé</Badge>}
            {canWrite && <ArchiveProductButton id={product.id} archived={archived} name={product.name} />}
          </>
        }
      />
      {created && <p className="mb-4 rounded-md bg-success-soft px-3 py-2 text-[13px] text-success">Article créé.</p>}
      <div className="max-w-3xl">
        <ProductForm
          id={product.id}
          readOnly={!canWrite || archived}
          rates={options.map((r) => ({ id: r.id, label: r.label, rate: r.rate, exemptionReason: r.exemptionReason }))}
          defaults={{
            reference: product.reference,
            name: product.name,
            description: product.description ?? "",
            category: product.category ?? "",
            kind: product.kind,
            unit: UNITS.find((u) => u === product.unit) ?? "unité",
            unitPriceExclTax: editablePrice(product.unitPriceExclTax),
            purchasePriceExclTax: product.purchasePriceExclTax ? editablePrice(product.purchasePriceExclTax) : "",
            vatRateId: product.vatRateId,
            barcode: product.barcode ?? "",
          }}
        />
      </div>
    </>
  );
}
