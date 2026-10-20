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
| `third_parties` | Clients et fournisseurs | type particulier / professionnel / organisme public (détermine l'application de l'art. 286 I 3° bis CGI aux règlements) ; code unique par entreprise ; SIREN, adresse de livraison distincte (mentions e-facture) ; archivage, jamais de suppression |
| `contacts` | Contacts d'un tiers | **clé étrangère composite (tiers, entreprise)** : impossible de rattacher un contact au tiers d'une autre entreprise |
| `products` | Catalogue | référence unique (insensible à la casse) ; nature bien / service (catégorie d'opération e-facture) ; PU HT numeric(15,4) ; **clé composite (taux de TVA, entreprise)** ; TTC jamais stocké |
| `sales_documents` | Devis, factures, avoirs | statut brouillon → émis (→ accepté / refusé pour un devis) ; numéro attribué à l'émission seulement, UNIQUE (entreprise, numéro) ; copies figées vendeur / client (jsonb) ; empreinte SHA-256 ; **trigger : document émis non modifiable ni supprimable**, seules les colonnes de suivi (statut de devis, montant réglé) évoluent ; CHECK de cohérence (numéro ⇔ émis, avoir ⇒ facture d'origine) |
| `sales_document_lines` | Lignes | quantité numeric(15,3), PU HT numeric(15,4), taux et motif d'exonération copiés ; clés composites (document, entreprise) et (article, entreprise) ; **figées dès l'émission** |
| `sales_document_vat` | Ventilation de TVA par taux | recalculée par le serveur ; figée à l'émission |

## Tables planifiées

| Module | Tables |
|---|---|
| Tiers | `attachments` (pièces jointes : nécessite un stockage de fichiers, dépendance à choisir) |
| Catalogue | `stock_movements` (si le module de stock est activé) |
| Ventes | factures d'acompte et déduction des acomptes (à venir) |
| Règlements | `payments` (append-only, idempotents), `payment_allocations` (lettrage paiement ↔ facture), `refunds` |
| Trésorerie | `bank_accounts`, `bank_transactions` (import relevés, empreinte d'import anti-doublon), `reconciliations`, `expenses` |
| Comptabilité | `accounts` (plan comptable), `journals`, `journal_entries` + `journal_entry_lines` (CHECK débit = crédit, verrouillage à la validation), `fiscal_years` (clôture), `lettering` |
| Caisse | `cash_registers`, `cash_sessions`, `cash_tickets` (+ lignes, paiements ; chaînés), `cash_closures` (J/M/A, totaux perpétuels, signature), `archives` |

## Principes
- Montants : `numeric`, jamais `real` / `double precision`.
- Suppression : `ON DELETE RESTRICT` pour toute donnée financière ; pas de suppression logique « silencieuse » des documents émis.
- Index : sur `company_id` + colonnes de recherche / tri de chaque table métier.
