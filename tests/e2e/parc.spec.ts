import { expect, test } from "@playwright/test";

/**
 * Domaine d'activité choisi à la création → menu adapté (Parc à côté des clients, pas de Caisse)
 * → matériel ajouté au parc d'un client → visible sur la fiche client et retrouvé par immatriculation.
 */

test("parc : activité « matériel agricole », menu adapté, matériel rattaché au client", async ({ page }) => {
  await page.goto("/register");
  await page.getByLabel("Nom complet").fill("Concessionnaire E2E");
  await page.getByLabel("Adresse e-mail").fill(`parc-${Date.now()}@exemple.test`);
  await page.getByLabel("Mot de passe").fill(`Essai-${Math.random().toString(36).slice(2)}-parc`);
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  await page.getByLabel("Raison sociale").fill("Tracteurs E2E SAS");
  await page.getByRole("checkbox", { name: /Vente de matériel agricole/ }).check();
  await page.getByRole("button", { name: "Créer l'entreprise" }).click();
  await expect(page).toHaveURL(/\/parametres\/entreprise/);

  // Menu : le parc suit « Clients & fournisseurs » ; la caisse n'est pas proposée.
  const nav = page.getByRole("navigation", { name: "Navigation principale" });
  const labels = await nav.getByRole("link").allInnerTexts();
  const items = labels.map((l) => l.trim());
  expect(items.indexOf("Parc matériel")).toBe(items.indexOf("Clients & fournisseurs") + 1);
  expect(items).not.toContain("Caisse");

  // Les paramètres reflètent le choix (activité et module cochés).
  await expect(page.getByRole("checkbox", { name: /Vente de matériel agricole/ })).toBeChecked();
  await expect(page.locator('input[name="modules"][value="parc"]')).toBeChecked();
  await expect(page.locator('input[name="modules"][value="caisse"]')).not.toBeChecked();

  // Client puis matériel ajouté depuis sa fiche.
  await page.goto("/tiers/nouveau");
  await page.locator("#name").fill("GAEC des Prés");
  await page.getByRole("button", { name: "Créer la fiche" }).click();
  await expect(page).toHaveURL(/\/tiers\/[0-9a-f-]{36}/);
  await page.locator('a[href^="/parc/nouveau?client="]').click();
  await expect(page).toHaveURL(/\/parc\/nouveau\?client=/);
  await page.locator("#category").selectOption("agricultural");
  await page.locator("#brand").fill("John Deere");
  await page.locator("#model").fill("6R 150");
  await page.locator("#serialNumber").fill("1rw6150xkp123456");
  await page.locator("#registration").fill("ab123cd");
  await page.locator("#meterValue").fill("12");
  await page.getByRole("button", { name: "Ajouter au parc" }).click();
  await expect(page).toHaveURL(/\/parc\/[0-9a-f-]{36}\?cree=1/);
  await expect(page.getByText("Matériel ajouté au parc de GAEC des Prés.")).toBeVisible();
  await expect(page.locator("#registration")).toHaveValue("AB-123-CD");
  await expect(page.getByText("Ajout au parc")).toBeVisible();

  // Fiche client : le matériel y figure ; recherche par immatriculation sans tirets.
  await page.getByRole("link", { name: "GAEC des Prés" }).first().click();
  await expect(page.getByRole("link", { name: "John Deere 6R 150" })).toBeVisible();
  await page.goto("/parc?q=AB123CD");
  await expect(page.getByRole("link", { name: "John Deere 6R 150" })).toBeVisible();
  await page.screenshot({ path: "test-results/parc.png", fullPage: true });
});
