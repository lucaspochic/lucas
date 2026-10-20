import type { Metadata } from "next";
import { Card, CardHeader, PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { requireCompanyContext } from "@/server/http/session";
import { listMembers } from "@/server/services/companies";
import { can, ROLE_LABELS } from "@/server/security/permissions";
import { formatDateTime } from "@/lib/utils";
import { AddMemberForm, RoleSelect } from "./members-client";

export const metadata: Metadata = { title: "Utilisateurs" };

export default async function MembersPage() {
  const { ctx } = await requireCompanyContext();
  const members = await listMembers(await getDb(), ctx);
  const manage = can(ctx, "members.manage");

  return (
    <>
      <PageHeader title="Utilisateurs" description="Personnes ayant accès à cette entreprise et leur rôle." />
      <div className="space-y-6">
        <Card>
          <CardHeader title={`${members.length} membre${members.length > 1 ? "s" : ""}`} />
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-border text-left text-xs text-foreground-muted">
                  <th className="px-5 py-2.5 font-medium">Nom</th>
                  <th className="px-5 py-2.5 font-medium">E-mail</th>
                  <th className="px-5 py-2.5 font-medium">Rôle</th>
                  <th className="px-5 py-2.5 font-medium">Membre depuis</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId} className="border-b border-border last:border-0">
                    <td className="px-5 py-3 font-medium">
                      {m.fullName}
                      {m.userId === ctx.userId && <span className="ml-2 text-xs text-foreground-subtle">(vous)</span>}
                    </td>
                    <td className="px-5 py-3 text-foreground-muted">{m.email}</td>
                    <td className="px-5 py-3">
                      {manage && m.userId !== ctx.userId ? (
                        <RoleSelect userId={m.userId} role={m.role} canGrantOwner={ctx.role === "owner"} />
                      ) : (
                        ROLE_LABELS[m.role]
                      )}
                    </td>
                    <td className="tabular px-5 py-3 text-foreground-muted">{formatDateTime(m.since)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {manage && (
          <Card>
            <CardHeader
              title="Ajouter un membre"
              description="La personne doit déjà disposer d'un compte. L'invitation par e-mail nécessitera la configuration d'un service d'envoi."
            />
            <AddMemberForm canGrantOwner={ctx.role === "owner"} />
          </Card>
        )}
      </div>
    </>
  );
}
