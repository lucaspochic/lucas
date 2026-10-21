"use client";

import { CsvImportForm } from "@/components/data/csv-import-form";
import { importStatementAction } from "@/app/actions/treasury";

export function StatementImport({ accountId }: { accountId: string }) {
  return <CsvImportForm action={(content) => importStatementAction(accountId, content)} backHref="/tresorerie" backLabel="Retour à la trésorerie" />;
}
