# Conception — module comptable (itération 6)

> Le logiciel **prépare** la comptabilité ; il ne remplace pas un expert-comptable et ne garantit pas à lui seul la conformité de la comptabilité de l'entreprise. Plan de comptes et schémas d'écritures **à valider avec l'expert-comptable**.

## Principes
1. **Écritures générées automatiquement**, dans la même transaction que l'événement métier (émission d'une facture ou d'un avoir, règlement, dépense validée, paiement fournisseur). Pas d'écriture en « brouillard » modifiable : une écriture naît validée (BOFiP : un brouillard modifiable ferait entrer le logiciel dans le champ des logiciels de caisse sans protection).
2. **Équilibre garanti par la base** : trigger différé vérifiant Σ débit = Σ crédit pour chaque écriture à la validation de la transaction.
3. **Intangibilité** : écritures et lignes en ajout seul (triggers). Une correction passe par une écriture inverse (avoir, contre-passation), jamais par modification.
4. **Idempotence** : une écriture par (type de source, source) — contrainte unique ; un rejeu ne crée pas de doublon.
5. **Numérotation continue** par journal et par exercice (`EcritureNum`).

## Journaux
| Code | Journal | Origine |
|---|---|---|
| VE | Ventes | factures et avoirs émis |
| AC | Achats | dépenses validées |
| BQ1, BQ2… | Banque (un par compte bancaire) | règlements clients et paiements fournisseurs par banque |
| CA | Caisse | règlements en espèces |
| OD | Opérations diverses | transfert de TVA sur encaissements |

## Schémas d'écritures
| Événement | Débit | Crédit |
|---|---|---|
| Facture émise | 411000 (auxiliaire client) TTC | 706000 prestations / 707000 marchandises (HT par nature) ; 44571x TVA collectée (ou 445740 « TVA en attente » pour les prestations sans option sur les débits) |
| Avoir émis | inverse de la facture | |
| Encaissement | 512xxx / 530000 | 411000 (auxiliaire) |
| Remboursement, contre-passation | inverse | |
| Encaissement sur prestations sans option débits | OD : 445740 | 44571x (quote-part de TVA encaissée ; solde à l'encaissement complet) |
| Dépense validée | 6xxxxx / 2xxxxx HT par ligne ; 445660 TVA déductible (445620 sur immobilisations) | 401000 (auxiliaire fournisseur) TTC |
| Paiement fournisseur | 401000 (auxiliaire) | 512xxx / 530000 |

Entreprise en **franchise en base** : pas de TVA collectée ; la TVA des fournisseurs, non récupérable, s'ajoute à la charge.

## Restitutions
Journal, grand livre (avec solde progressif), balance générale, échéancier clients / fournisseurs, **export FEC** (art. A. 47 A-1 du LPF : 18 zones, séparateur tabulation, dates AAAAMMJJ, montants à virgule, fichier `SIRENFECAAAAMMJJ.txt`).

## Hors périmètre de cette itération (documenté)
Lettrage automatique des comptes de tiers (zones FEC `EcritureLet` / `DateLet` laissées vides), clôture d'exercice et à-nouveaux, déclaration de TVA (CA3), immobilisations et amortissements, paie.
