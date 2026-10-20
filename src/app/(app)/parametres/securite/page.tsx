import type { Metadata } from "next";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "Sécurité" };

export default function SecurityPage() {
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
            title="Authentification à deux facteurs"
            description="Non disponible dans cette version. Prévue : codes TOTP (application d'authentification)."
          />
        </Card>
      </div>
    </>
  );
}
