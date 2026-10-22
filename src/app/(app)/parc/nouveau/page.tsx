import type { Metadata } from "next";
import Link from "next/link";
import { Users } from "lucide-react";
import { Card, EmptyState, PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/http/session";
import { customerOptions, invoicesOfParty } from "@/server/services/equipment";
import { EQUIPMENT_CATEGORIES } from "@/lib/schemas";
import { EquipmentForm } from "../equipment-form";

export const metadata: Metadata = { title: "Ajouter un matériel" };

/** Paramètres facultatifs : ?client=… (fiche tiers) et &facture=… (facture émise). */
export default async function NewEquipmentPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const { ctx } = await requirePermission("thirdparties.write");
  const db = await getDb();
  const customers = await customerOptions(db, ctx);
  const client = customers.find((c) => c.id === params.client)?.id ?? "";
  const invoices = client ? await invoicesOfParty(db, ctx, client) : [];
  const invoice = invoices.find((i) => i.id === params.facture);
  const category = EQUIPMENT_CATEGORIES.find((c) => c === params.categorie) ?? "vehicle";

  return (
    <>
      <PageHeader title="Ajouter un matériel" description="Le matériel est rattaché à la fiche du client propriétaire." />
      {customers.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Users className="size-5" aria-hidden />}
            title="Aucun client"
            description="Créez d'abord la fiche du client propriétaire."
            action={
              <Link href="/tiers/nouveau" className="text-sm font-medium text-accent hover:underline">
                Créer un client
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="max-w-3xl">
          <EquipmentForm
            customers={customers}
            initialInvoices={invoices.map((i) => ({ id: i.id, number: i.number, issueDate: i.issueDate }))}
            defaults={{
              thirdPartyId: client,
              category,
              brand: "",
              model: "",
              serialNumber: "",
              registration: "",
              year: "",
              meterValue: "",
              meterUnit: category === "vehicle" ? "km" : category === "other" ? "" : "h",
              salesDocumentId: invoice?.id ?? "",
              soldOn: invoice?.issueDate ?? "",
              warrantyEndsOn: "",
              notes: "",
            }}
          />
        </div>
      )}
    </>
  );
}
