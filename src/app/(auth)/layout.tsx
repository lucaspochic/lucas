import { redirect } from "next/navigation";
import { getSession } from "@/server/http/session";
import { Logo } from "@/components/layout/logo";

export const dynamic = "force-dynamic";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  if (await getSession()) redirect("/tableau-de-bord");
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-surface px-4 py-12">
      <div className="mb-8">
        <Logo />
      </div>
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}
