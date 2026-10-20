import Link from "next/link";
import type { Metadata } from "next";
import { Card } from "@/components/ui/card";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Connexion" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  return (
    <>
      <Card className="p-6">
        <h1 className="text-lg font-semibold">Connexion</h1>
        <p className="mt-1 text-sm text-foreground-muted">Accédez à votre espace de gestion.</p>
        {params.motdepasse === "modifie" && (
          <p className="mt-4 rounded-md bg-success-soft px-3 py-2 text-[13px] text-success">
            Mot de passe modifié. Reconnectez-vous avec le nouveau mot de passe.
          </p>
        )}
        <div className="mt-6">
          <LoginForm />
        </div>
      </Card>
      {process.env.ALLOW_SELF_SIGNUP !== "false" && (
        <p className="mt-4 text-center text-[13px] text-foreground-muted">
          Pas encore de compte ?{" "}
          <Link href="/register" className="font-medium text-accent hover:underline">
            Créer un compte
          </Link>
        </p>
      )}
    </>
  );
}
