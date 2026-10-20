"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import type { ActionResult } from "@/server/http/action-result";

const MAX_BYTES = 2 * 1024 * 1024;

type Report = { imported: number; errors: { line: number; message: string }[] };

/** Formulaire d'import CSV : lecture locale du fichier, envoi du texte, affichage du rapport ligne à ligne. */
export function CsvImportForm({
  action,
  backHref,
  backLabel,
}: {
  action: (content: string) => Promise<ActionResult<Report>>;
  backHref: string;
  backLabel: string;
}) {
  const [pending, startTransition] = useTransition();
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = () =>
    startTransition(async () => {
      setError(null);
      setReport(null);
      if (!file) return;
      if (file.size > MAX_BYTES) return setError("Fichier trop volumineux (2 Mo au maximum).");
      const content = await file.text();
      const result = await action(content);
      if (!result.ok) return setError(result.error);
      setReport(result.data!);
      if (result.data!.imported > 0) toast.success(`${result.data!.imported} ligne(s) importée(s).`);
    });

  return (
    <div className="space-y-4">
      <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong bg-background px-6 py-8 text-center hover:bg-muted/50">
        <Upload className="size-5 text-foreground-muted" aria-hidden />
        <span className="text-sm font-medium">{file ? file.name : "Choisir un fichier CSV"}</span>
        <span className="text-xs text-foreground-subtle">Séparateur « ; » ou « , », encodage UTF-8, 2 Mo et 5 000 lignes au maximum</span>
        <input
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setReport(null);
            setError(null);
          }}
        />
      </label>

      {error && <FormAlert>{error}</FormAlert>}

      {report && report.errors.length > 0 && (
        <div className="rounded-lg border border-danger/20 bg-danger-soft p-4">
          <p className="text-sm font-medium text-danger">
            Aucune ligne importée : {report.errors.length} erreur(s) à corriger dans le fichier.
          </p>
          <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto text-[13px] text-danger">
            {report.errors.map((e, i) => (
              <li key={i}>
                {e.line > 0 && <span className="font-medium">Ligne {e.line} — </span>}
                {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {report && report.errors.length === 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-success/20 bg-success-soft p-4 text-sm text-success">
          <CheckCircle2 className="size-4" aria-hidden />
          {report.imported} ligne(s) importée(s).
          <Link href={backHref} className="ml-auto font-medium underline">
            {backLabel}
          </Link>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Link href={backHref} className="inline-flex h-9 items-center rounded-md px-4 text-sm font-medium text-foreground-muted hover:bg-muted">
          Retour
        </Link>
        <Button onClick={submit} disabled={!file} loading={pending}>
          Importer
        </Button>
      </div>
    </div>
  );
}
