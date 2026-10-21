# Gestion — logiciel de gestion commerciale et comptable

Application web pour TPE, PME, indépendants et commerçants français : entreprises, tiers, catalogue, devis, factures, règlements, trésorerie, comptabilité et caisse.

> **État : itération 11.** Livré : authentification, entreprises multi-sociétés, rôles, paramètres légaux et fiscaux, journal d'audit inaltérable chaîné, numérotation continue, moteur de calcul HT/TVA/TTC, clients et fournisseurs (contacts, archivage), catalogue de produits et services, import/export CSV contrôlé, devis, factures et avoirs (émission numérotée, documents figés, impression / PDF), règlements (encaissements, remboursements, contre-passations ; en ajout seul, chaînés, protégés contre les doubles envois). tableau de bord sur données réelles, dépenses fournisseurs, trésorerie (comptes, import de relevés, rapprochement, prévision). comptabilité automatique (journaux, grand livre, balance, échéancier, lettrage, saisie d'OD, aide à la déclaration de TVA, clôture d'exercice et à-nouveaux, export FEC), caisse (tickets chaînés, remboursements liés, mode école, sessions et écarts, clôtures journalières / mensuelles / annuelles signées, archives ZIP vérifiables). Double authentification (TOTP, codes de secours), pièces jointes (dépenses, documents de vente, tiers). factures d'acompte et de solde, relances (lettres, e-mail), PDF serveur, export CII (EN 16931). Prochaines étapes : industrialisation (sauvegarde/restauration testée, tests de bout en bout, intégration continue) puis branchement de la plateforme de facturation électronique — voir `docs/00-diagnostic.md`.
>
> **Conformité :** aucune certification NF525 / LNE n'est obtenue ni revendiquée. Voir `docs/05-registre-reglementaire.md` et `docs/06-conformite-caisse-nf525.md`.

## Prérequis

- **Node.js 24 LTS**. Sur le poste de développement initial, une version portable est installée dans `.tools/node` (non versionnée). Pour l'utiliser dans un terminal PowerShell :
  ```powershell
  $env:Path = "$PWD\.tools\node;$env:Path"
  ```
- Aucune base à installer pour le développement : PostgreSQL embarqué (PGlite) dans `.data/pglite`.
- Production : PostgreSQL 17 et Docker (voir `docker-compose.yml`).
- Recommandé : Git (non installé sur le poste initial).

## Démarrage (développement)

```bash
npm install
cp .env.example .env          # Windows : copy .env.example .env
npm run dev                   # http://localhost:3000
```
Les migrations sont appliquées automatiquement au premier accès à la base. Créez un compte depuis `/register`.

Données de démonstration (jamais en production) — **application arrêtée**, car PGlite n'accepte qu'un processus :
```bash
npm run db:seed-demo          # identifiants écrits dans .data/demo-credentials.txt
```

## Commandes

| Commande | Rôle |
|---|---|
| `npm run dev` | Serveur de développement |
| `npm run build` / `npm start` | Build et serveur de production |
| `npm test` | Tests unitaires et d'intégration (Vitest, base PGlite en mémoire) |
| `npm run typecheck` / `npm run lint` | Typage strict / ESLint |
| `npm run check` | Les trois précédents |
| `npm run db:generate` | Génère une migration SQL après modification de `src/server/db/schema.ts` |
| `npm run db:migrate` | Applique les migrations sur `DATABASE_URL` |
| `npm run audit:verify` | Contrôle d'intégrité complet : journaux d'audit, chaîne des règlements, empreintes des documents émis, chaînes et signatures des caisses (code 2 si altération) |
| `npm run cash:keygen` | Génère les secrets de production : clé Ed25519 de signature de caisse et clé de chiffrement des secrets de double authentification |
| `npm run user:reset-mfa -- e-mail` | Désactive la double authentification d'un utilisateur (téléphone et codes de secours perdus ; sessions fermées, audit) |
| `npm run accounting:backfill` | Comptabilise les opérations antérieures au module comptable (idempotent) |
| `npm run user:create -- e-mail "Nom"` | Crée un compte (premier compte d'une installation sans inscription libre) ; mot de passe aléatoire affiché une fois |
| `npm run user:reset-password -- e-mail` | Réinitialise le mot de passe d'un utilisateur (mot de passe aléatoire affiché une fois, sessions fermées, audit) |
| `TEST_POSTGRES_URL=postgres://… npm test` | Exécute les tests sur un PostgreSQL serveur (base jetable par fichier de test) |

Astuce tests : `PASSWORD_SCRYPT_LOG_N=14 npm test` accélère le hachage (jamais en production).

## Variables d'environnement
Voir `.env.example` (documentées ligne à ligne).

## Documentation

| Fichier | Contenu |
|---|---|
| `docs/00-diagnostic.md` | Diagnostic initial, risques, plan d'exécution |
| `docs/01-architecture.md` | Architecture et décisions |
| `docs/02-schema-donnees.md` | Schéma de données (livré et planifié) |
| `docs/03-roles-permissions.md` | Matrice des rôles et permissions |
| `docs/04-regles-calcul.md` | Règles de calcul financier et d'arrondi |
| `docs/05-registre-reglementaire.md` | Registre des exigences réglementaires, sources, statut |
| `docs/06-conformite-caisse-nf525.md` | Conception ISCA et points à valider avant toute revendication |
| `docs/07-securite.md` | Mesures de sécurité |
| `docs/08-sauvegarde-restauration.md` | Sauvegarde et restauration |
| `docs/09-mise-en-production.md` | Checklist de mise en production |
| `docs/10-api.md` | Interfaces serveur |

## Structure

```
src/app/              pages Next.js et Server Actions (aucune règle métier)
src/components/       composants d'interface
src/lib/schemas.ts    schémas de validation partagés client/serveur
src/server/domain/    règles métier pures (montants, TVA, identifiants, numérotation)
src/server/services/  opérations métier transactionnelles et auditées
src/server/security/  mots de passe, permissions
src/server/db/        schéma et connexion
drizzle/              migrations SQL versionnées
tests/                tests unitaires et d'intégration
scripts/              migrations, démonstration, vérification d'audit
```
