import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/http/session";
import { listVatRates } from "@/server/services/companies";
import { ProductForm } from "../product-form";

export const metadata: Metadata = { title: "Nouvel article" };

export default async function NewProductPage() {
  const { ctx } = await requirePermission("catalog.write");
  const rates = (await listVatRates(await getDb(), ctx)).filter((r) => r.active);
  return (
    <>
      <PageHeader title="Nouvel article" />
      <ProductForm
        rates={rates.map((r) => ({ id: r.id, label: r.label, rate: r.rate, exemptionReason: r.exemptionReason }))}
        defaults={{
          reference: "",
          name: "",
          kind: "service",
          unit: "unité",
          unitPriceExclTax: "",
          vatRateId: rates[0]?.id ?? "",
        }}
      />
    </>
  );
}
