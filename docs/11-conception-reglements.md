# Conception — module de règlements (itération 4)

Statut : **implémenté** (itération 4, 21/10/2026) — `src/server/services/payments.ts`, migrations 0005-0006, `tests/integration/payments.test.ts` (17 tests, verts sur PGlite et PostgreSQL 17). Les clients du logiciel vendent à des particuliers : l'enregistrement des règlements est donc dans le champ du 3° bis du I de l'art. 286 CGI (BOFiP §30-40). Voir `docs/06-conformite-caisse-nf525.md`.

## Principes
1. **Append-only** : un règlement enregistré n'est jamais modifié ni supprimé. Une erreur se corrige par une **contre-passation** (règlement négatif lié au règlement d'origine, motif obligatoire), elle-même inaltérable.
2. **Idempotence** : chaque enregistrement porte une clé d'idempotence générée par le navigateur (table `idempotency_keys`). Un double clic ou un rejeu réseau renvoie le résultat du premier envoi, sans doublon.
3. **Chaînage par règlement** : chaque règlement porte l'empreinte du précédent de l'entreprise (en plus du journal d'audit), et les données exigées par le BOFiP §50 : n° de justificatif, horodatage à la minute, montant TTC, mode de paiement, détail de l'imputation.
4. **Imputation (lettrage)** : un règlement peut solder une ou plusieurs factures ; le montant imputé sur une facture ne dépasse jamais son reste à payer (contrôle sous verrou). Le surplus reste en avoir client.
5. **Remboursement** : lié à un avoir émis ; sortie d'argent tracée comme un règlement négatif.
6. **Statut de paiement** dérivé (jamais saisi) : non réglée / partiellement réglée / réglée / en retard (échéance dépassée), à partir de `amount_paid` mis à jour dans la même transaction que le règlement.

## Tables prévues
| Table | Rôle |
|---|---|
| `payments` | id, entreprise, n° de justificatif (séquence continue), horodatage, client, mode (espèces, chèque, CB, virement, prélèvement, autre), montant (signé), référence externe, contre-passation de, motif, empreinte, empreinte précédente |
| `payment_allocations` | règlement ↔ facture ou avoir, montant imputé |

Triggers : refus de tout UPDATE / DELETE / TRUNCATE sur ces deux tables.

## Tests prévus
- Paiement partiel puis solde ; statut dérivé.
- Rejeu de la même clé d'idempotence : un seul règlement.
- Imputation supérieure au reste à payer : refusée, y compris sous concurrence (PostgreSQL réel).
- Contre-passation : solde de la facture rétabli, historique intact.
- Altération d'un règlement en contournant les triggers : détectée par la chaîne.
- Isolation inter-entreprises.

## Hors périmètre de l'itération 4
Clôtures journalières / mensuelles / annuelles, totaux perpétuels, archivage signé : module caisse (itération 9).
