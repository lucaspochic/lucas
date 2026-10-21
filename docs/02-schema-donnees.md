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
| `ledger_accounts`, `journals` | Plan de comptes (PCG) et journaux (VE, AC, OD, BQn, CAn) | plan par défaut créé avec l'entreprise ; un journal par compte de trésorerie |
| `journal_entries`, `journal_lines` | Écritures comptables | numéro continu par exercice ; origine unique (idempotence) ; **ajout seul** ; **équilibre Σ débit = Σ crédit contrôlé par trigger de contrainte différé** ; débit ou crédit (jamais les deux) |
| `letterings`, `lettering_lines` | Lettrage des comptes 411 / 401 | code unique par compte ; une ligne dans un seul lettrage (clé primaire) ; même compte et même tiers (trigger) ; **solde nul contrôlé en fin de transaction** ; seul le délettrage (une fois) est permis, liens retirés ensuite seulement |
| `fiscal_year_closures` | Exercices clôturés | unique (entreprise, exercice) ; résultat, totaux, écriture d'à-nouveaux ; **ajout seul** ; **trigger sur `journal_entries` refusant toute écriture d'un exercice clos** |
| `attachments` | Pièces jointes (dépenses, documents de vente, tiers) | type réel détecté (PDF, PNG, JPEG, WebP), taille, SHA-256 ; contenu sur disque (`ATTACHMENTS_DIR`) adressé par empreinte ; **ni suppression ni modification** (trigger) : seul le retrait (marquage) est permis, refusé par le service pour le justificatif d'une opération validée |
| `mfa_recovery_codes`, `mfa_challenges` | Double authentification | codes de secours hachés à usage unique ; défis de connexion de 5 min (empreinte du jeton) ; secret TOTP chiffré dans `users.mfa_secret` |
| `cash_registers` | Caisses | numéro court unique par entreprise (`^[A-Z0-9]{1,6}$`) ; compte de caisse (530) en clé composite |
| `cash_sessions` | Ouvertures / fermetures | une seule session ouverte par caisse (index partiel) ; fond, espèces attendues / comptées, écart ; **trigger : session fermée immuable, données d'ouverture non modifiables, suppression interdite** |
| `cash_tickets`, `cash_ticket_lines`, `cash_ticket_payments` | Tickets de caisse | rang continu par caisse, numéro `CODE-000001` ; vente ou remboursement lié (CHECK de signe, motif obligatoire) ; mode école ; empreinte chaînée par caisse ; **ajout seul** (UPDATE / DELETE / TRUNCATE refusés) |
| `cash_closures` | Clôtures J / M / A | unique (caisse, type, début) et (caisse, rang) ; totaux, grand total, total perpétuel, cumul des valeurs absolues, ventilations TVA et paiements (jsonb) ; empreinte chaînée, signature Ed25519 et identifiant de clé ; **ajout seul** |
| `cash_archives` | Archives produites | période, nom de fichier, SHA-256 du ZIP, signature du manifeste ; **ajout seul** |

## Tables planifiées

| Module | Tables |
|---|---|
| Catalogue | `stock_movements` (si le module de stock est activé) |
| Ventes | factures d'acompte et déduction des acomptes, relances |
| Caisse | conservation des clés publiques successives (rotation) |

## Principes
- Montants : `numeric`, jamais `real` / `double precision`.
- Suppression : `ON DELETE RESTRICT` pour toute donnée financière ; pas de suppression logique « silencieuse » des documents émis.
- Index : sur `company_id` + colonnes de recherche / tri de chaque table métier.
