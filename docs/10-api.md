# Interfaces serveur

L'application n'expose pas encore d'API REST publique. Les opérations passent par des **Server Actions** Next.js (appels POST protégés par contrôle d'origine), qui délèguent aux services. Une API REST versionnée (`/api/v1`) avec jetons d'API par entreprise est prévue pour les intégrations (expert-comptable, plateformes agréées).

## Route HTTP

| Méthode | Chemin | Auth | Réponse |
|---|---|---|---|
| GET | `/api/health` | non | `200 {"status":"ok"}` ou `503 {"status":"error"}` |
| GET | `/api/exports/tiers` | session + `exports.run` | CSV UTF-8 (BOM, « ; »), tiers actifs ; 401 / 403 sinon |
| GET | `/api/exports/catalogue` | session + `exports.run` | CSV des articles actifs, décimaux à la française |

## Server Actions (`src/app/actions`)

Toutes retournent `ActionResult` : `{ ok: true, data?, message? }` ou `{ ok: false, error, fieldErrors? }`.

| Action | Entrée | Permission | Effet | Audit |
|---|---|---|---|---|
| `loginAction` | `{ email, password }` | — | Ouvre une session, cookie, redirection | `user.logged_in` (chaîne système) |
| `registerAction` | `{ fullName, email, password }` | inscription ouverte | Crée le compte, ouvre la session | `user.registered` |
| `logoutAction` | — | session | Supprime la session | — |
| `changePasswordAction` | `{ currentPassword, newPassword, confirmPassword }` | session | Change le mot de passe, révoque toutes les sessions | `user.password_changed` |
| `createCompanyAction` | `{ legalName, siren?, vatRegime }` | session | Crée l'entreprise, rôle propriétaire, taux de TVA | `company.created` |
| `updateCompanyAction` | `companySchema` | `company.update` | Met à jour les paramètres | `company.updated` (différentiel) |
| `switchCompanyAction` | `companyId` | adhésion | Change l'entreprise active de la session | — |
| `addMemberAction` | `{ email, role }` | `members.manage` | Rattache un compte existant | `member.added` |
| `changeMemberRoleAction` | `userId, role` | `members.manage` | Change le rôle | `member.role_changed` |
| `verifyAuditAction` | — | `audit.verify` | Recalcule la chaîne d'audit | — |

## Services (`src/server/services`)
Signature commune : `(db, ctx: CompanyContext, input: unknown)`. L'entrée est revalidée par Zod dans le service ; la permission est vérifiée en première instruction.

## Server Actions — itération 2

| Action | Permission | Audit |
|---|---|---|
| `createThirdPartyAction`, `updateThirdPartyAction` | `thirdparties.write` | `third_party.created` / `third_party.updated` (différentiel) |
| `archiveThirdPartyAction` | `thirdparties.write` | `third_party.archived` / `third_party.restored` |
| `addContactAction`, `removeContactAction` | `thirdparties.write` | `contact.added` / `contact.removed` |
| `importThirdPartiesAction` | `thirdparties.write` | un `third_party.created` par ligne (source `import`) ; tout ou rien |
| `createProductAction`, `updateProductAction`, `archiveProductAction` | `catalog.write` | `product.*` |
| `importProductsAction` | `catalog.write` | un `product.created` par ligne ; tout ou rien |

Règle : les schémas Zod partagés sont **idempotents** (le formulaire envoie la sortie du schéma, que le serveur revalide) — testé dans `tests/unit/schemas.test.ts`.

## Server Actions — itération 3 (ventes)

| Action | Permission | Effet | Audit |
|---|---|---|---|
| `createSalesDraftAction(type, valeurs)` | `sales.write` | Brouillon de devis ou de facture, montants recalculés | `sales_document.draft_created` |
| `updateSalesDraftAction` | `sales.write` | Remplace lignes et totaux d'un brouillon | `sales_document.draft_updated` |
| `deleteSalesDraftAction` | `sales.write` | Supprime un brouillon (jamais un document émis) | `sales_document.draft_deleted` |
| `issueSalesDocumentAction(id, accepterAvertissements)` | `sales.issue` | Numéro, date du jour, copies figées, empreinte ; renvoie les avertissements à confirmer | `sales_document.issued` (avec l'empreinte) |
| `respondToQuoteAction` | `sales.write` | Devis émis → accepté / refusé | `sales_document.quote_*` |
| `convertQuoteAction` | `sales.write` | Brouillon de facture depuis un devis (une seule fois) | `sales_document.invoice_from_quote` |
| `createCreditNoteAction` | `sales.write` | Brouillon d'avoir reprenant la facture | `sales_document.credit_note_drafted` |

Page d'impression : `GET /impression/ventes/{id}` (session requise, documents émis uniquement).

Les formulaires d'authentification utilisent `loginFormAction`, `registerFormAction`, `changePasswordFormAction` (FormData, amélioration progressive).
