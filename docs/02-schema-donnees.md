# Schéma de données

Source de vérité : `src/server/db/schema.ts`. Migrations : `drizzle/`.

## Tables livrées (itération 1)

| Table | Rôle | Points clés |
|---|---|---|
| `users` | Comptes | e-mail unique insensible à la casse (index sur `lower(email)`), hash scrypt, `password_changed_at` (invalide les sessions antérieures), désactivation sans suppression |
| `sessions` | Sessions ouvertes | `token_hash` unique (SHA-256), expiration, entreprise active |
| `login_attempts` | Limitation de débit | e-mail haché (`email_key`), IP, purge à 30 jours |
| `companies` | Entreprises | identité, fiscalité, règlement, préfixes ; contraintes CHECK (mois d'exercice, délai ≤ 60 j, devise ISO) ; `is_demo` |
| `memberships` | Adhésion utilisateur ↔ entreprise | clé (user, company), rôle (enum) ; `ON DELETE RESTRICT` côté entreprise |
| `vat_rates` | Taux de TVA de l'entreprise | CHECK 0–100 ; motif obligatoire si taux nul ; unicité (entreprise, taux, motif) |
| `document_sequences` | Compteurs de numérotation | clé (entreprise, type, exercice) ; verrouillée à l'émission |
| `audit_events` | Journal append-only chaîné | `(company, chain_seq)` unique ; `prev_hash`, `hash` ; **triggers refusant UPDATE/DELETE/TRUNCATE** |
| `idempotency_keys` | Anti-rejeu | clé (entreprise, clé) ; empreinte de la requête ; réponse mémorisée |

## Tables planifiées

| Module | Tables |
|---|---|
| Tiers | `third_parties` (client/fournisseur, SIREN, TVA, adresse facturation/livraison, conditions), `contacts`, `attachments` |
| Catalogue | `products` (référence unique par entreprise, PU HT numeric(15,4), taux, unité, code-barres, archivé), `product_categories`, `stock_movements` (si stock activé) |
| Ventes | `sales_documents` (devis, facture, acompte, avoir ; statut ; numéro UNIQUE (entreprise, numéro) ; **colonnes figées après émission**), `sales_document_lines`, `sales_document_vat` (ventilation par taux), `document_events` |
| Règlements | `payments` (append-only, idempotents), `payment_allocations` (lettrage paiement ↔ facture), `refunds` |
| Trésorerie | `bank_accounts`, `bank_transactions` (import relevés, empreinte d'import anti-doublon), `reconciliations`, `expenses` |
| Comptabilité | `accounts` (plan comptable), `journals`, `journal_entries` + `journal_entry_lines` (CHECK débit = crédit, verrouillage à la validation), `fiscal_years` (clôture), `lettering` |
| Caisse | `cash_registers`, `cash_sessions`, `cash_tickets` (+ lignes, paiements ; chaînés), `cash_closures` (J/M/A, totaux perpétuels, signature), `archives` |

## Principes
- Montants : `numeric`, jamais `real` / `double precision`.
- Suppression : `ON DELETE RESTRICT` pour toute donnée financière ; pas de suppression logique « silencieuse » des documents émis.
- Index : sur `company_id` + colonnes de recherche / tri de chaque table métier.
