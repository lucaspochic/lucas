import { expect, test } from "@playwright/test";

/** Parcours caisse : ouverture, vente avec rendu de monnaie, fermeture, clôture et contrôle. */

test("caisse : vente, fermeture de session, clôture du jour, intégrité", async ({ page }) => {
  const email = `caisse-${Date.now()}@exemple.test`;
  await page.goto("/register");
  await page.getByLabel("Nom complet").fill("Caissière E2E");
  await page.getByLabel("Adresse e-mail").fill(email);
  await page.getByLabel("Mot de passe").fill(`Essai-${Math.random().toString(36).slice(2)}-caisse`);
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  await page.getByLabel("Raison sociale").fill("Boulangerie E2E");
  await page.getByRole("button", { name: "Créer l'entreprise" }).click();
  await expect(page).toHaveURL(/\/parametres\/entreprise/);

  // Création de la caisse et ouverture avec un fond de 50 €.
  await page.goto("/caisse");
  await page.getByLabel("Numéro").fill("C1");
  await page.getByPlaceholder("Comptoir").fill("Comptoir");
  await page.getByRole("button", { name: "Créer la caisse" }).click();
  await expect(page.getByRole("heading", { name: "Caisse C1 — Comptoir" })).toBeVisible();
  await page.getByLabel("Fond de caisse (€)").fill("50");
  await page.getByRole("button", { name: "Ouvrir la caisse" }).click();

  // Vente d'un article libre : 2,40 € payés en espèces avec un billet de 5 €.
  await page.getByLabel("Libellé").fill("Croissant");
  await page.getByLabel("Prix TTC").fill("1,20");
  await page.getByLabel("Taux de TVA").selectOption({ label: "TVA 5,5 %" });
  await page.getByRole("button", { name: "Ajouter" }).click();
  await page.getByRole("button", { name: "Ajouter un Croissant" }).click();
  await expect(page.getByText("2,40 €").first()).toBeVisible();
  await page.getByRole("button", { name: "Espèces" }).click();
  await page.getByLabel("Espèces remises par le client").fill("5");
  await expect(page.getByText("Rendu 2,60 €")).toBeVisible();
  await page.getByRole("button", { name: /Encaisser/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Ticket C1-000001 enregistré" })).toContainText("Rendu monnaie : 2,60 €");

  // Fermeture de session : 52,40 € comptés, aucun écart ; puis clôture du jour.
  await page.getByLabel("Espèces comptées (€)").fill("52,40");
  await page.getByRole("button", { name: "Fermer la session" }).click();
  await expect(page.getByText(/aucun écart/)).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Clôturer la journée" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Clôturer" }).click();
  await expect(page.getByText(/journée clôturée/)).toBeVisible();
  await page.getByRole("button", { name: /Contrôler l'intégrité/ }).click();
  await expect(page.getByText(/Intègre : 1 ticket\(s\) et 1 clôture\(s\)/)).toBeVisible();
  await page.screenshot({ path: "test-results/caisse-cloturee.png", fullPage: true });
});
