import type { Metadata } from "next";
import Link from "next/link";
import { Users } from "lucide-react";
import { Card, EmptyState, PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/http/session";
import { listVatRates } from "@/server/services/companies";
import { listCustomerOptions, listProductOptions } from "@/server/services/sales";
import { SalesEditor } from "../sales-editor";

export const metadata: Metadata = { title: "Nouveau document" };

export default async function NewSalesDocumentPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const type = (await searchParams).type === "devis" ? "quote" : "invoice";
  const { ctx } = await requirePermission("sales.write");
  const db = await getDb();
  const [customers, productOptions, rates] = await Promise.all([listCustomerOptions(db, ctx), listProductOptions(db, ctx), listVatRates(db, ctx)]);
  const defaultRate = rates.find((r) => r.active)?.id ?? "";

  return (
    <>
      <PageHeader
        title={type === "quote" ? "Nouveau devis" : "Nouvelle facture"}
        description="Le document reste un brouillon modifiable, sans numéro, jusqu'à son émission."
      />
      {customers.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Users className="size-5" aria-hidden />}
            title="Aucun client"
            description="Créez d'abord la fiche du client à facturer."
            action={
              <Link href="/clients/nouveau" className="text-sm font-medium text-accent hover:underline">
                Créer un client
              </Link>
            }
          />
        </Card>
      ) : (
        <SalesEditor
          type={type}
          customers={customers}
          productOptions={productOptions}
          rates={rates.map((r) => ({ id: r.id, label: r.label, rate: r.rate, exemptionReason: r.exemptionReason, active: r.active }))}
          defaults={{
            thirdPartyId: "",
            deliveryDate: "",
            globalDiscountPercent: "0",
            notes: "",
            lines: [{ productId: null, description: "", kind: "service", quantity: "1", unit: "unité", unitPriceExclTax: "", discountPercent: "0", vatRateId: defaultRate }],
          }}
        />
      )}
    </>
  );
}
