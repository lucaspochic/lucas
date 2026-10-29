import { expect, test } from "@playwright/test";

/**
 * Rubriques séparées : un fournisseur créé depuis « Fournisseurs » n'apparaît pas chez les clients ;
 * s'il devient aussi client, il figure dans les deux rubriques, et l'ancien lien /tiers/{id} redirige.
 */

test("tiers : rubriques Clients et Fournisseurs séparées", async ({ page }) => {
  await page.goto("/register");
  await page.getByLabel("Nom complet").fill("Acheteur E2E");
  await page.getByLabel("Adresse e-mail").fill(`tiers-${Date.now()}@exemple.test`);
  await page.getByLabel("Mot de passe").fill(`Essai-${Math.random().toString(36).slice(2)}-tiers`);
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  await page.getByLabel("Raison sociale").fill("Atelier E2E SARL");
  await page.getByRole("button", { name: "Créer l'entreprise" }).click();
  await expect(page).toHaveURL(/\/parametres\/entreprise/);

  const items = (await page.getByRole("navigation", { name: "Navigation principale" }).getByRole("link").allInnerTexts()).map((l) => l.trim());
  expect(items).toContain("Clients");
  expect(items).toContain("Fournisseurs");
  expect(items).not.toContain("Clients & fournisseurs");

  // Fournisseur : rôle et type pré-remplis par la rubrique.
  await page.goto("/fournisseurs/nouveau");
  await expect(page.getByRole("heading", { name: "Nouveau fournisseur" })).toBeVisible();
  await expect(page.getByLabel("Fournisseur", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Client", { exact: true })).not.toBeChecked();
  await page.locator("#name").fill("Négoce Martin SAS");
  await page.getByRole("button", { name: "Créer la fiche" }).click();
  await expect(page).toHaveURL(/\/fournisseurs\/[0-9a-f-]{36}\?cree=1/);
  const id = page.url().match(/[0-9a-f-]{36}/)![0];

  await page.goto("/fournisseurs");
  await expect(page.getByRole("link", { name: "Négoce Martin SAS" })).toBeVisible();
  await page.goto("/clients");
  await expect(page.getByText("Aucun client")).toBeVisible();

  // Ouvert depuis la mauvaise rubrique ou par l'ancien lien : renvoyé chez les fournisseurs.
  await page.goto(`/clients/${id}`);
  await expect(page).toHaveURL(new RegExp(`/fournisseurs/${id}$`));
  await page.goto(`/tiers/${id}`);
  await expect(page).toHaveURL(new RegExp(`/fournisseurs/${id}$`));

  // Devient aussi client : présent dans les deux rubriques, avec un lien de l'une à l'autre.
  await page.getByLabel("Client", { exact: true }).check();
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByText("Fiche enregistrée.")).toBeVisible();
  await page.goto("/clients");
  await expect(page.getByRole("link", { name: "Négoce Martin SAS" })).toBeVisible();
  await expect(page.getByText("Aussi fournisseur")).toBeVisible();
  await page.getByRole("link", { name: "Négoce Martin SAS" }).click();
  await expect(page).toHaveURL(new RegExp(`/clients/${id}$`));
  await page.getByRole("link", { name: /Aussi fournisseur/ }).click();
  await expect(page).toHaveURL(new RegExp(`/fournisseurs/${id}$`));
  await page.screenshot({ path: "test-results/fournisseurs.png", fullPage: true });
});
