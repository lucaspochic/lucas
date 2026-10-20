import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Logo } from "@/components/layout/logo";
import { requireSession } from "@/server/http/session";
import { getDb } from "@/server/db/client";
import { listUserCompanies } from "@/server/services/companies";
import { OnboardingForm } from "./onboarding-form";

export const metadata: Metadata = { title: "Nouvelle entreprise" };
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const session = await requireSession();
  const companies = await listUserCompanies(await getDb(), session.userId);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-surface px-4 py-12">
      <div className="mb-8">
        <Logo />
      </div>
      <Card className="w-full max-w-md p-6">
        <h1 className="text-lg font-semibold">{companies.length ? "Ajouter une entreprise" : "Votre entreprise"}</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          Quelques informations pour démarrer. Vous compléterez les mentions légales ensuite.
        </p>
        <div className="mt-6">
          <OnboardingForm />
        </div>
      </Card>
      {companies.length > 0 && (
        <Link href="/tableau-de-bord" className="mt-4 text-[13px] text-foreground-muted hover:text-foreground">
          ← Retour au tableau de bord
        </Link>
      )}
    </main>
  );
}
