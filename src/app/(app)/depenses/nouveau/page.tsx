import type { Metadata } from "next";
import Link from "next/link";
import { Users } from "lucide-react";
import { Card, EmptyState, PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/http/session";
import { listSupplierOptions } from "@/server/services/expenses";
import { todayInParis } from "@/server/domain/numbering";
import { ExpenseEditor } from "../expense-editor";

export const metadata: Metadata = { title: "Nouvelle dépense" };

export default async function NewExpensePage() {
  const { ctx } = await requirePermission("purchases.write");
  const suppliers = await listSupplierOptions(await getDb(), ctx);
  return (
    <>
      <PageHeader title="Nouvelle dépense" description="Reste un brouillon modifiable jusqu'à sa validation." />
      {suppliers.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Users className="size-5" aria-hidden />}
            title="Aucun fournisseur"
            description="Créez d'abord la fiche du fournisseur."
            action={
              <Link href="/fournisseurs/nouveau" className="text-sm font-medium text-accent hover:underline">
                Créer un fournisseur
              </Link>
            }
          />
        </Card>
      ) : (
        <ExpenseEditor
          suppliers={suppliers.map((s) => ({ id: s.id, label: `${s.name} (${s.code})` }))}
          defaults={{
            thirdPartyId: "",
            supplierReference: "",
            invoiceDate: todayInParis(),
            dueDate: "",
            notes: "",
            lines: [{ category: "autre", description: "", amountExclTax: "", vatRate: "20", vatAmount: "" }],
          }}
        />
      )}
    </>
  );
}
