import type { Metadata } from "next";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { getDb } from "@/server/db/client";
import { requireSession } from "@/server/http/session";
import { mfaStatus } from "@/server/services/mfa";
import { ChangePasswordForm } from "./change-password-form";
import { MfaSettings } from "./mfa-settings";

export const metadata: Metadata = { title: "Sécurité" };
export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const session = await requireSession();
  const status = await mfaStatus(await getDb(), session.userId);
  return (
    <>
      <PageHeader title="Sécurité du compte" />
      <div className="max-w-xl space-y-6">
        <Card>
          <CardHeader
            title="Mot de passe"
            description="La modification ferme toutes vos sessions ouvertes, sur tous les appareils."
          />
          <CardBody>
            <ChangePasswordForm />
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Double authentification"
            description="Un code à usage unique, généré par une application sur votre téléphone, est demandé à chaque connexion en plus du mot de passe."
          />
          <CardBody>
            <MfaSettings
              enabled={status.enabled}
              enabledAt={status.enabledAt ? status.enabledAt.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" }) : null}
              recoveryRemaining={status.recoveryRemaining}
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
