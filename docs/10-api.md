# Interfaces serveur

L'application n'expose pas encore d'API REST publique. Les opérations passent par des **Server Actions** Next.js (appels POST protégés par contrôle d'origine), qui délèguent aux services. Une API REST versionnée (`/api/v1`) avec jetons d'API par entreprise est prévue pour les intégrations (expert-comptable, plateformes agréées).

## Route HTTP

| Méthode | Chemin | Auth | Réponse |
|---|---|---|---|
| GET | `/api/health` | non | `200 {"status":"ok"}` ou `503 {"status":"error"}` |

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
