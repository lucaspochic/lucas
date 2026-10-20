import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Card } from "@/components/ui/card";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "Créer un compte" };

export default function RegisterPage() {
  if (process.env.ALLOW_SELF_SIGNUP === "false") notFound();
  return (
    <>
      <Card className="p-6">
        <h1 className="text-lg font-semibold">Créer un compte</h1>
        <p className="mt-1 text-sm text-foreground-muted">Vous configurerez votre entreprise à l&apos;étape suivante.</p>
        <div className="mt-6">
          <RegisterForm />
        </div>
      </Card>
      <p className="mt-4 text-center text-[13px] text-foreground-muted">
        Déjà inscrit ?{" "}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Se connecter
        </Link>
      </p>
    </>
  );
}
