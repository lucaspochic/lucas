# Diagnostic initial — 20/10/2026

## 1. État actuel du projet

| Élément | Constat |
|---|---|
| Dépôt | Dossier `C:\Users\10\Desktop\logiciel` **vide** au démarrage. Aucune contrainte technique héritée. |
| Gestion de versions | Git **non installé** sur la machine, le dossier n'est pas un dépôt. À installer (voir README) avant toute collaboration. |
| Runtime | Node.js absent du système. **Node.js 24.22.0 LTS portable** installé dans `.tools/node` (archive officielle nodejs.org, SHA-256 vérifié). |
| Base de données | Ni PostgreSQL ni Docker disponibles. Le développement et les tests utilisent **PGlite** (PostgreSQL 17 compilé en WebAssembly, même moteur SQL, mêmes triggers). La production cible un **PostgreSQL serveur** (Docker fourni). |
| Mise à jour du 20/10/2026 | Git, Docker Desktop et un dépôt GitHub sont désormais en place. La suite de tests passe aussi sur **PostgreSQL 17 serveur** (concurrence réelle), et la pile `docker compose` (PostgreSQL + migrations + application) a été construite et vérifiée. |
| Conséquence (situation initiale) | Les fichiers Docker sont fournis mais **n'ont pas pu être testés sur ce poste**. Les tests de concurrence réelle (verrous de ligne entre connexions) ne peuvent être exécutés qu'avec un PostgreSQL serveur (PGlite = une seule connexion). |

## 2. Architecture recommandée

Monolithe modulaire TypeScript, un seul déploiement, frontières internes strictes.

```
src/
  app/                    Next.js (App Router) — UI et points d'entrée HTTP uniquement
  components/             Composants d'interface (aucune règle métier)
  server/
    domain/               Règles pures, sans E/S : montants, TVA, numérotation, SIREN/TVA…
    services/             Cas d'usage transactionnels (une fonction = une opération métier)
    security/             Mots de passe, sessions, limitation de débit, permissions
    db/                   Schéma Drizzle, connexion, migrations
drizzle/                  Migrations SQL versionnées (dont triggers d'inaltérabilité)
tests/                    unit/ (domaine), integration/ (services + vraie base PGlite)
docs/                     Documentation d'architecture, règles, conformité
```

| Couche | Choix | Justification |
|---|---|---|
| Frontend | Next.js + React + TypeScript, Tailwind CSS, composants style shadcn/ui (Radix), Lucide, React Hook Form + Zod | Conforme au cahier des charges ; Zod partagé client/serveur pour la validation. |
| Backend | Server Actions et Route Handlers Next.js → **services** → **domaine** | Pas de seconde application à maintenir ; la protection CSRF native des Server Actions (contrôle d'origine) est conservée. |
| ORM | **Drizzle ORM** (équivalent Prisma autorisé par le cahier des charges) | Fonctionne à l'identique sur PGlite et PostgreSQL ; migrations SQL lisibles où l'on peut écrire les triggers d'inaltérabilité ; requêtes typées. |
| Montants | `numeric` PostgreSQL + `decimal.js` côté TypeScript | Aucun flottant binaire ; règles d'arrondi explicites (voir `docs/04-regles-calcul.md`). |
| Inaltérabilité | Journal d'audit append-only **chaîné par SHA-256**, triggers PostgreSQL refusant UPDATE/DELETE sur les données validées | Défense en profondeur : application + base. |
| Tests | Vitest (unitaires + intégration sur base PGlite réelle), Playwright prévu pour l'E2E | |

## 3. Modules à développer

1. Socle : authentification, entreprises, adhésions/rôles, journal d'audit, numérotation — **livré dans cette itération**
2. Tiers (clients, fournisseurs, contacts, import/export CSV)
3. Catalogue (produits, services, taux de TVA)
4. Devis, factures, avoirs (cycle documentaire, PDF, Factur-X)
5. Encaissements, acomptes, remboursements
6. Tableau de bord (indicateurs réels documentés)
7. Trésorerie et dépenses (comptes, relevés, rapprochement)
8. Comptabilité (plan comptable, journaux, écritures, lettrage, FEC)
9. Caisse (sessions, tickets, clôtures J/M/A, totaux perpétuels, archives) — module soumis à l'art. 286 I 3° bis CGI

## 4. Schéma de données initial

Voir `docs/02-schema-donnees.md` (tables livrées et tables planifiées) et `src/server/db/schema.ts` (source de vérité).

## 5. Principaux risques techniques

| Risque | Impact | Mesure |
|---|---|---|
| Erreurs d'arrondi | Montants faux, écart TVA | `decimal.js` + `numeric`, règles documentées, tests exhaustifs |
| Numérotation non séquentielle sous concurrence | Trous ou doublons de numéros | Compteur par (entreprise, type, exercice) verrouillé `SELECT … FOR UPDATE` dans la transaction d'émission + contrainte UNIQUE |
| Fuite inter-entreprises | Grave (RGPD, secret des affaires) | Contexte entreprise vérifié côté serveur à chaque requête, `company_id` obligatoire dans tous les services, tests d'isolation. RLS PostgreSQL envisagé en défense supplémentaire |
| Modification silencieuse de données validées | Non-conformité ISCA / intangibilité | Triggers base + absence de fonction de modification + chaîne de hachage vérifiable |
| Rejeu de requêtes financières | Double encaissement | Clé d'idempotence obligatoire sur les opérations de paiement (table `idempotency_keys`) |
| PGlite ≠ PostgreSQL serveur | Comportement différent en production | Même moteur SQL ; CI à compléter avec un PostgreSQL réel (service Docker) |
| Évolution réglementaire rapide (LF 2025 → LF 2026, réforme e-facture) | Code obsolète | Registre réglementaire daté (`docs/05-registre-reglementaire.md`) à revoir à chaque version |
| Absence de Git sur le poste | Perte de travail, pas de revue | Installer Git avant la suite |

## 6. Exigences réglementaires à clarifier

### Signification de « ISCA »
Dans le contexte des logiciels de caisse, **ISCA** désigne les quatre conditions posées par le **3° bis du I de l'article 286 du CGI** : **I**naltérabilité, **S**écurisation, **C**onservation, **A**rchivage des données. Le BOFiP (BOI-TVA-DECLA-30-10-30) détaille ces quatre conditions ; le référentiel de certification LNE (v1.6) indique couvrir le respect de ces conditions.
Limite : le sigle lui-même est un usage de la profession (LNE, éditeurs) ; les textes officiels emploient les quatre termes, pas l'acronyme. **À confirmer avec vous** si « ISCA » désignait autre chose dans votre contexte.

### NF525 / logiciels de caisse — points ouverts
- **Le logiciel est-il dans le champ ?** Oui dès qu'il mémorise extra-comptablement des encaissements de clients particuliers (BOFiP §30-40). Un logiciel de facturation qui enregistre les règlements de non-assujettis est assimilé à un logiciel de caisse **pour cette seule fonctionnalité**. Si vos clients ne vendent qu'à des professionnels (B2B pur), ils sont hors champ.
- **Mode de preuve** : la LF 2025 (art. 43) avait supprimé l'attestation de l'éditeur ; la page impots.gouv modifiée le 14/10/2026 indique que cette suppression « est donc annulée » par la LF 2026. Certificat d'un organisme accrédité **ou** attestation individuelle de l'éditeur. → Décision commerciale à prendre : viser la certification (LNE / Infocert) ou l'attestation éditeur.
- **NF525** est une marque de certification (Infocert) ; le LNE délivre sa propre certification. Aucune n'est revendiquée par ce logiciel.

### Facturation électronique
Réception obligatoire pour toutes les entreprises depuis le 01/09/2026 ; émission + e-reporting au 01/09/2027 pour PME et micro-entreprises. Le logiciel devra produire des factures structurées (UBL, CII ou format mixte type Factur-X) et s'interfacer avec une **plateforme agréée** (dépendance externe : contrat + API d'une plateforme immatriculée).

## 7. Plan d'exécution priorisé

| # | Étape | Statut |
|---|---|---|
| 1 | Diagnostic, architecture, registre réglementaire | ✅ cette itération |
| 2 | Socle : Next.js, Drizzle, migrations, PGlite, tests, lint | ✅ cette itération |
| 3 | Auth (scrypt, sessions opaques, limitation des tentatives), entreprises, rôles, isolation, journal d'audit chaîné, moteur de calcul TVA | ✅ cette itération |
| 4 | Tiers + catalogue + import/export CSV | ✅ itération 2 |
| 5 | Devis/factures/avoirs, émission avec numérotation, impression / PDF | ✅ itération 3 (factures d'acompte : à venir) |
| 6 | Encaissements idempotents, soldes, avoirs/remboursements | ✅ itération 4 |
| 6 bis | Tableau de bord sur données réelles | ✅ itération 5 |
| 7 | Tableau de bord sur données réelles | |
| 8 | Trésorerie, dépenses, rapprochement | |
| 9 | Comptabilité, écritures automatiques, FEC | |
| 10 | Caisse : clôtures, totaux perpétuels, archives signées | |
| 11 | Factur-X / UBL, connecteur plateforme agréée | dépend d'un partenaire |
| 12 | MFA TOTP, RLS, E2E Playwright, CI avec PostgreSQL réel | Docker validé ✅ ; tests PostgreSQL réel en local ✅ |
