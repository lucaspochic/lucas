import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Garde-fou : un <form> sans méthode s'envoie en GET si l'utilisateur valide avant le
 * chargement du JavaScript, ce qui place les saisies (dont les mots de passe) dans l'URL.
 * Régression constatée et corrigée le 20/10/2026. Chaque formulaire doit donc déclarer
 * method="post" ou utiliser une Server Action en attribut action.
 */
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? tsxFiles(full) : full.endsWith(".tsx") ? [full] : [];
  });
}

describe("formulaires", () => {
  it("aucun formulaire ne peut être envoyé en GET", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(path.resolve(__dirname, "../../src"))) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/<form\b[^>]*>/g)) {
        const tag = match[0];
        if (!/method="post"/.test(tag) && !/action=\{/.test(tag)) offenders.push(`${path.relative(process.cwd(), file)} : ${tag}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("les champs de mot de passe sont dans des formulaires en amélioration progressive", () => {
    for (const file of tsxFiles(path.resolve(__dirname, "../../src"))) {
      const source = readFileSync(file, "utf8");
      if (source.includes('type="password"')) expect(source, file).toMatch(/<form action=\{action\}/);
    }
  });
});
