"use client";

import { useActionState, useState, useTransition } from "react";
import { Download, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { confirmMfaAction, disableMfaFormAction, regenerateRecoveryCodesAction, startMfaAction } from "@/app/actions/mfa";
import type { CredentialFormState } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form-controls";
import { FormAlert } from "@/components/ui/form-alert";

function RecoveryCodes({ codes }: { codes: string[] }) {
  const download = () => {
    const blob = new Blob([`Codes de secours (usage unique) — à conserver en lieu sûr\r\n\r\n${codes.join("\r\n")}\r\n`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "codes-de-secours.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3 rounded-md border border-warning bg-warning-soft p-4">
      <p className="text-[13px] font-medium text-warning">
        Conservez ces codes en lieu sûr : chacun permet une connexion si vous n&apos;avez plus votre téléphone. Ils ne seront plus affichés.
      </p>
      <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <Button size="sm" variant="secondary" onClick={download}>
        <Download className="size-3.5" aria-hidden /> Télécharger (.txt)
      </Button>
    </div>
  );
}

function Enrollment({ onEnabled }: { onEnabled: (codes: string[]) => void }) {
  const [pending, startTransition] = useTransition();
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!setup) {
    return (
      <Button
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await startMfaAction();
            if (r.ok) setSetup(r.data!);
            else toast.error(r.error);
          })
        }
      >
        Activer la double authentification
      </Button>
    );
  }
  return (
    <form
      method="post"
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const r = await confirmMfaAction(code);
          if (!r.ok) return setError(r.error);
          toast.success(r.message);
          onEnabled(r.data!.codes);
        });
      }}
    >
      <ol className="list-decimal space-y-2 pl-5 text-[13px] text-foreground-muted">
        <li>Ouvrez votre application d&apos;authentification (Google Authenticator, Microsoft Authenticator, FreeOTP, 1Password…).</li>
        <li>Scannez ce QR code, ou saisissez la clé manuellement.</li>
        <li>Indiquez le code à 6 chiffres affiché.</li>
      </ol>
      <div className="flex flex-wrap items-center gap-4">
        {/* SVG produit par le serveur à partir de l'URI otpauth : aucune donnée saisie n'y figure en texte. */}
        <div className="size-44 rounded bg-white p-1 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: setup.qrSvg }} aria-label="QR code de configuration" role="img" />
        <div className="text-[13px]">
          <p className="text-foreground-muted">Clé :</p>
          <p className="font-mono text-sm tracking-wider">{setup.secret.match(/.{1,4}/g)!.join(" ")}</p>
        </div>
      </div>
      {error && <FormAlert>{error}</FormAlert>}
      <Field label="Code à 6 chiffres" htmlFor="mfa-code">
        <Input id="mfa-code" autoComplete="one-time-code" inputMode="numeric" maxLength={7} className="w-40 text-center tracking-widest" value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>
      <Button type="submit" loading={pending} disabled={code.replace(/\s/g, "").length !== 6}>
        Confirmer et activer
      </Button>
    </form>
  );
}

function Regenerate() {
  const [pending, startTransition] = useTransition();
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  if (codes) return <RecoveryCodes codes={codes} />;
  return (
    <form
      method="post"
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const r = await regenerateRecoveryCodesAction(code);
          if (!r.ok) return void toast.error(r.error);
          toast.success(r.message);
          setCodes(r.data!.codes);
        });
      }}
    >
      <Field label="Code actuel" htmlFor="mfa-regen">
        <Input id="mfa-regen" autoComplete="one-time-code" maxLength={20} className="w-40" value={code} onChange={(e) => setCode(e.target.value)} />
      </Field>
      <Button type="submit" variant="secondary" loading={pending} disabled={!code.trim()}>
        Générer de nouveaux codes de secours
      </Button>
    </form>
  );
}

function Disable() {
  const [state, action, pending] = useActionState<CredentialFormState, FormData>(disableMfaFormAction, {});
  if (state.restart) return <p className="text-[13px] text-foreground-muted">Double authentification désactivée.</p>;
  return (
    <form action={action} className="space-y-3">
      {state.error && <FormAlert>{state.error}</FormAlert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Mot de passe" htmlFor="mfa-off-password" error={state.fieldErrors?.password}>
          <Input id="mfa-off-password" name="password" type="password" autoComplete="current-password" required maxLength={256} />
        </Field>
        <Field label="Code ou code de secours" htmlFor="mfa-off-code" error={state.fieldErrors?.code}>
          <Input id="mfa-off-code" name="code" autoComplete="one-time-code" required maxLength={20} />
        </Field>
      </div>
      <Button type="submit" variant="danger" loading={pending}>
        Désactiver
      </Button>
    </form>
  );
}

export function MfaSettings({ enabled, enabledAt, recoveryRemaining }: { enabled: boolean; enabledAt: string | null; recoveryRemaining: number }) {
  // Codes affichés une seule fois : conservés ici pour survivre au rafraîchissement de la page.
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  if (newCodes) {
    return (
      <div className="space-y-4">
        <p className="flex items-center gap-2 text-[13px] text-success">
          <ShieldCheck className="size-4" aria-hidden /> Double authentification activée.
        </p>
        <RecoveryCodes codes={newCodes} />
        <Button size="sm" variant="ghost" onClick={() => setNewCodes(null)}>
          J&apos;ai conservé mes codes
        </Button>
      </div>
    );
  }
  if (!enabled) return <Enrollment onEnabled={setNewCodes} />;
  return (
    <div className="space-y-6">
      <p className="flex items-center gap-2 text-[13px] text-success">
        <ShieldCheck className="size-4" aria-hidden /> Activée{enabledAt ? ` depuis le ${enabledAt}` : ""} · {recoveryRemaining} code(s) de secours restant(s)
      </p>
      <Regenerate />
      <div className="border-t border-border pt-4">
        <p className="mb-3 text-[13px] font-medium">Désactiver la double authentification</p>
        <Disable />
      </div>
    </div>
  );
}
