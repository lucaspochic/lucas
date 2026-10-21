import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDb } from "@/server/db/client";
import { orNotFound, requireCompanyContext } from "@/server/http/session";
import { getSalesDocument } from "@/server/services/sales";
import { documentLabel } from "@/server/domain/sales";
import { DocumentView } from "@/app/(app)/ventes/document-view";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const { ctx } = await requireCompanyContext();
  const { doc } = await orNotFound(getSalesDocument(await getDb(), ctx, id));
  // Le titre devient le nom de fichier proposé lors de l'enregistrement en PDF.
  return { title: { absolute: `${documentLabel(doc)} ${doc.number ?? "brouillon"}` } };
}

/**
 * Version imprimable d'un document émis (impression ou « Enregistrer au format PDF » du navigateur).
 * Ce PDF est un document de consultation : il ne constitue pas une facture électronique au sens
 * de la réforme (format structuré UBL / CII / Factur-X via plateforme agréée — à venir).
 */
export default async function PrintSalesDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ctx } = await requireCompanyContext();
  const { doc, lines, vat, source } = await orNotFound(getSalesDocument(await getDb(), ctx, id));
  if (doc.status === "draft") notFound();
  return (
    <main className="min-h-screen bg-[#f1f3f6] py-8 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[210mm] justify-end print:hidden">
        <PrintButton />
      </div>
      <div className="shadow-card print:shadow-none">
        <DocumentView doc={doc} lines={lines} vat={vat} sourceNumber={source?.number ?? null} />
      </div>
    </main>
  );
}
