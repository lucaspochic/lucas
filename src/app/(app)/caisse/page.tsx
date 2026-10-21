import type { Metadata } from "next";
import Link from "next/link";
import { Store } from "lucide-react";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { requirePermission } from "@/server/http/session";
import { can } from "@/server/security/permissions";
import { getRegister, listRegisters } from "@/server/services/cash";
import { formatEuro } from "@/server/domain/money";
import { formatDate } from "../ventes/sales-ui";
import { NewRegisterForm } from "./cash-client";

export const metadata: Metadata = { title: "Caisse" };

export default async function CashRegistersPage() {
  const { ctx } = await requirePermission("cash.operate");
  const db = await getDb();
  const registers = await Promise.all((await listRegisters(db, ctx)).map((r) => getRegister(db, ctx, r.id)));
  const canCreate = can(ctx, "company.update");

  return (
    <>
      <PageHeader
        title="Caisse"
        description="Encaissement au comptoir : tickets numérotés et chaînés, clôtures signées, archives vérifiables."
      />
      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Caisses" />
          {registers.length === 0 ? (
            <EmptyState
              icon={<Store className="size-5" aria-hidden />}
              title="Aucune caisse"
              description={canCreate ? "Créez une première caisse pour commencer à encaisser." : "Un administrateur doit créer une caisse."}
            />
          ) : (
            <ul className="divide-y divide-border">
              {registers.map(({ register, openSession, lastDayClosure, perpetualTotal }) => (
                <li key={register.id}>
                  <Link href={`/caisse/${register.id}`} className="flex flex-wrap items-center gap-4 px-5 py-4 hover:bg-muted/50">
                    <div className="flex size-9 items-center justify-center rounded-full bg-muted font-mono text-xs font-semibold">{register.code}</div>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        {register.name}
                        {openSession ? <Badge tone="success">Ouverte</Badge> : <Badge>Fermée</Badge>}
                      </p>
                      <p className="text-xs text-foreground-muted">
                        {lastDayClosure ? `Dernière clôture : ${formatDate(lastDayClosure.periodStart)}` : "Aucune clôture"}
                      </p>
                    </div>
                    <div className="text-right text-xs text-foreground-muted">
                      Total perpétuel
                      <p className="tabular text-sm font-semibold text-foreground">{formatEuro(perpetualTotal)}</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="space-y-6">
          {canCreate && <NewRegisterForm />}
          <Card>
            <CardHeader title="Conditions ISCA" />
            <div className="space-y-2 px-5 py-4 text-[13px] text-foreground-muted">
              <p>
                Le module est conçu pour les conditions d&apos;inaltérabilité, de sécurisation, de conservation et d&apos;archivage
                (CGI, art. 286, I, 3° bis) : aucun ticket ne peut être modifié ni supprimé, les corrections passent par un
                remboursement lié, les clôtures sont automatiques et signées.
              </p>
              <p>
                Le justificatif exigé (certificat ou attestation individuelle de l&apos;éditeur) n&apos;est pas délivré par le
                logiciel lui-même : voir la documentation du projet.
              </p>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
