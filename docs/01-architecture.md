# Architecture technique

## Vue d'ensemble

Monolithe modulaire Next.js (App Router) en TypeScript strict. Un seul processus sert l'interface et la logique serveur ; les frontières internes sont strictes :

```
Navigateur ──► app/ (pages, Server Actions, Route Handlers)      ← HTTP, cookies, redirections
                 │  aucune règle métier ici
                 ▼
             server/services/   cas d'usage : autorisation, transaction, audit
                 │
                 ├──► server/domain/   règles pures (montants, TVA, identifiants, numérotation)
                 └──► server/db/       schéma Drizzle + connexion (PGlite ou PostgreSQL)
```

| Dossier | Rôle | Règles |
|---|---|---|
| `src/server/domain` | Fonctions pures, déterministes, sans E/S | Testées unitairement ; aucune dépendance à la base ni à Next |
| `src/server/services` | Une fonction exportée = une opération métier | Reçoit `db` et un `CompanyContext` ; vérifie la permission ; ouvre la transaction ; écrit l'événement d'audit dans la même transaction |
| `src/server/security` | Mots de passe, permissions, JSON canonique | |
| `src/server/http` | Pont Next.js ↔ services (cookies, session, normalisation des erreurs) | `server-only` : ne peut pas être importé côté client |
| `src/app/actions` | Server Actions | Minces : session → service → `ActionResult` |
| `src/lib/schemas.ts` | Schémas Zod partagés | Le client valide pour le confort, le serveur revalide toujours |
| `drizzle/` | Migrations SQL versionnées | Les triggers d'inaltérabilité y sont écrits à la main |

## Flux d'une opération

1. Le formulaire (React Hook Form + Zod) valide en direct.
2. La Server Action est appelée ; Next.js vérifie l'en-tête `Origin` (CSRF).
3. `requireCompanyContext()` valide le jeton de session (empreinte SHA-256 en base) puis l'adhésion à l'entreprise active.
4. Le service vérifie la permission (`assertPermission`), revalide l'entrée (Zod), exécute la transaction, ajoute l'événement d'audit chaîné.
5. Les erreurs métier (`AppError`) sont renvoyées telles quelles ; les erreurs internes sont journalisées en JSON avec une référence courte, communiquée à l'utilisateur.

## Base de données

- **Production** : PostgreSQL 17 (`DATABASE_URL=postgres://…`), pool `pg`.
- **Développement, démonstration, tests** : PGlite (`DATABASE_URL=pglite:./.data/pglite` ou `pglite:memory`), PostgreSQL compilé en WebAssembly : mêmes types, mêmes triggers, même SQL. Les migrations sont appliquées automatiquement à l'ouverture.
- Limite PGlite : une seule connexion par processus ; les tests de concurrence y sont sérialisés. Les verrous `FOR UPDATE` / `pg_advisory_xact_lock` sont valides mais ne sont réellement mis à l'épreuve qu'en PostgreSQL serveur (job CI prévu).

## Multi-entreprises

- Toute table métier porte `company_id`.
- Le `CompanyContext` n'est construit que par `resolveCompanyContext()` à partir de la table `memberships`. Les services n'acceptent jamais un `company_id` venant du client sans ce contexte.
- L'entreprise active est stockée dans la session côté serveur (et non dans un cookie modifiable).
- Défense en profondeur envisagée : Row Level Security PostgreSQL avec `SET LOCAL app.company_id` dans chaque transaction.

## Sécurité

Voir `docs/03-roles-permissions.md` et `docs/07-securite.md`.

## Décisions et hypothèses

| Décision | Raison |
|---|---|
| Drizzle plutôt que Prisma | Fonctionne nativement sur PGlite (pas de Docker sur le poste), migrations SQL éditables pour les triggers. |
| Composants « style shadcn » écrits à la main | Évite l'outil CLI interactif ; mêmes principes (Radix + Tailwind), code possédé par le projet. |
| Sessions opaques en base plutôt que JWT | Révocation immédiate (déconnexion, changement de mot de passe, désactivation). |
| scrypt (Node natif) plutôt qu'argon2 | Aucune dépendance native à compiler ; paramètres OWASP ; format de hash évolutif. |
| Montants en `numeric` + `decimal.js` | Exigence de précision ; aucun flottant binaire. |
