import { expect, test, type Page } from "@playwright/test";
import { totp } from "../../src/server/security/totp";

/**
 * Parcours complet d'un nouvel utilisateur, dans un vrai navigateur, sur une base jetable :
 * inscription → entreprise → paramètres légaux → client → facture émise → PDF → règlement
 * → double authentification → reconnexion en deux temps.
 */

const email = `e2e-${Date.now()}@exemple.test`;
const password = `Essai-${Math.random().toString(36).slice(2)}-e2e`;

async function fill(page: Page, selector: string, value: string) {
  const field = page.locator(selector);
  await field.fill(value);
  await expect(field).toHaveValue(value);
}

test.describe.configure({ mode: "serial" });

test("parcours : inscription, facturation, règlement, double authentification", async ({ page }) => {
  // Inscription et entreprise.
  await page.goto("/register");
  await page.getByLabel("Nom complet").fill("Utilisatrice E2E");
  await page.getByLabel("Adresse e-mail").fill(email);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel("Raison sociale").fill("Atelier E2E SAS");
  await page.getByRole("button", { name: "Créer l'entreprise" }).click();
  await expect(page).toHaveURL(/\/parametres\/entreprise\?bienvenue=1/);

  // Paramètres obligatoires pour émettre des factures.
  await page.goto("/parametres/entreprise");
  await fill(page, "#siren", "732829320");
  await fill(page, "#vatNumber", "FR44732829320");
  await fill(page, "#addressLine1", "1 rue de l'Essai");
  await fill(page, "#postalCode", "69001");
  await fill(page, "#city", "Lyon");
  await fill(page, "#latePenaltyText", "Pénalités : trois fois le taux d'intérêt légal ; indemnité forfaitaire de 40 € pour frais de recouvrement.");
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByText(/enregistr/i).first()).toBeVisible();

  // Client.
  await page.goto("/tiers/nouveau");
  await fill(page, "#name", "Jeanne Cliente");
  await fill(page, "#billingLine1", "2 place du Marché");
  await fill(page, "#billingPostalCode", "69002");
  await fill(page, "#billingCity", "Lyon");
  await page.getByRole("button", { name: "Créer la fiche" }).click();
  await expect(page).toHaveURL(/\/tiers\/[0-9a-f-]{36}/);

  // Facture : brouillon puis émission.
  await page.goto("/ventes/nouveau?type=facture");
  await page.locator("#thirdPartyId").selectOption({ label: "Jeanne Cliente (C00001)" });
  await page.getByLabel("Désignation, ligne 1").fill("Accompagnement");
  await fill(page, "#q-0", "2");
  await fill(page, "#p-0", "150");
  await page.getByRole("button", { name: "Créer le brouillon" }).click();
  await expect(page).toHaveURL(/\/ventes\/[0-9a-f-]{36}/);
  await page.getByRole("button", { name: "Émettre" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: /Émettre/ }).click();
  await expect(page.getByRole("heading", { name: /^Facture FA-\d{4}-\d{5}$/ })).toBeVisible();
  await expect(page.getByText("Intégrité vérifiée")).toBeVisible();
  const invoiceUrl = page.url();

  // PDF produit par le serveur.
  const id = invoiceUrl.split("/").pop()!;
  const pdf = await page.request.get(`/api/ventes/${id}/pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");

  // Règlement intégral depuis la facture.
  await page.getByRole("link", { name: "Enregistrer" }).click();
  await expect(page).toHaveURL(/\/reglements\/nouveau/);
  await fill(page, "#amount", "360");
  await page.getByRole("button", { name: /Enregistrer le règlement|Enregistrer/ }).last().click();
  await expect(page).toHaveURL(/\/reglements\/[0-9a-f-]{36}/);
  await page.goto(invoiceUrl);
  await expect(page.getByText("Réglée", { exact: false }).first()).toBeVisible();

  // Double authentification : activation.
  await page.goto("/parametres/securite");
  await page.getByRole("button", { name: "Activer la double authentification" }).click();
  const secret = (await page.locator("p.font-mono").first().innerText()).replace(/\s/g, "");
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await page.getByLabel("Code à 6 chiffres").fill(totp(secret));
  await page.getByRole("button", { name: "Confirmer et activer" }).click();
  await expect(page.getByText("Conservez ces codes en lieu sûr")).toBeVisible();
  const recovery = await page.locator("ul.font-mono li").allInnerTexts();
  expect(recovery).toHaveLength(10);

  // Déconnexion, puis reconnexion en deux temps (code de secours).
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Adresse e-mail").fill(email);
  await page.getByLabel("Mot de passe").fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page.getByLabel("Code de vérification")).toBeVisible();
  await page.getByLabel("Code de vérification").fill("000000");
  await page.getByRole("button", { name: "Vérifier" }).click();
  await expect(page.getByText(/Code incorrect/)).toBeVisible();
  await page.getByLabel("Code de vérification").fill(recovery[0]!);
  await page.getByRole("button", { name: "Vérifier" }).click();
  await expect(page).toHaveURL(/\/tableau-de-bord/);
});

test("pages protégées : redirection vers la connexion sans session", async ({ page }) => {
  for (const path of ["/tableau-de-bord", "/ventes", "/comptabilite", "/caisse"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login/);
  }
  const api = await page.request.get("/api/exports/fec?exercice=2026");
  expect(api.status()).toBe(401);
});
