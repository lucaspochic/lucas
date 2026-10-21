# Descriptif du fichier des écritures comptables (FEC)

Document à remettre avec le FEC à l'administration (LPF, art. A. 47 A-1, XI). Sources vérifiées le 21/10/2026 : LPF art. A. 47 A-1 (Légifrance LEGIARTI000027804775, en vigueur depuis le 02/08/2013) ; BOFiP BOI-CF-IOR-60-40-20-20170607.

## Caractéristiques
| Élément | Valeur |
|---|---|
| Nom du fichier | `<SIREN>FEC<AAAAMMJJ>.txt`, AAAAMMJJ = date de clôture de l'exercice |
| Structure | Fichier à plat, enregistrements de longueur variable |
| Séparateur de zones | Tabulation |
| Séparateur d'enregistrements | Retour chariot + fin de ligne (CR LF) |
| Première ligne | Noms des 18 zones |
| Jeu de caractères | Unicode ISO/CEI 10646, UTF-8 (sans indicateur d'ordre des octets) |
| Dates | AAAAMMJJ sans séparateur |
| Montants | Virgule décimale, sans séparateur de milliers ; Debit et Credit toujours renseignés (« 0,00 » pour le sens non utilisé) |
| Tri | Écritures d'à-nouveaux (journal AN) en tête, puis ordre chronologique de validation (ordre croissant de `EcritureNum`). L'écriture d'à-nouveaux est créée à la clôture de l'exercice précédent : son numéro peut donc être supérieur à celui d'écritures de l'exercice déjà enregistrées. Ordre à faire confirmer (voir `docs/05`). |
| Périmètre | Écritures de l'exercice ; aucune écriture de centralisation ni de solde des comptes de gestion |

## Zones
| N° | Zone | Contenu dans le logiciel |
|---|---|---|
| 1 | JournalCode | AN à-nouveaux, VE ventes, VC ventes caisse, AC achats, BQ1… banques, CA1… caisses, OD opérations diverses (dont saisies manuelles) |
| 2 | JournalLib | Libellé du journal |
| 3 | EcritureNum | Numéro **unique et continu pour tout l'exercice**, tous journaux confondus (toutes les lignes d'une écriture partagent le même numéro) |
| 4 | EcritureDate | Date de l'événement comptabilisé (émission de la facture, date du paiement, date de la facture fournisseur) |
| 5 | CompteNum | Compte du plan comptable général (6 chiffres) |
| 6 | CompteLib | Libellé du compte |
| 7 | CompAuxNum | Code du tiers (ex. C00012) sur les comptes 411 / 401 ; vide sinon |
| 8 | CompAuxLib | Nom du tiers ; vide sinon |
| 9 | PieceRef | Numéro de la pièce : facture, avoir, règlement (RG), dépense (ACH), paiement fournisseur (PF) |
| 10 | PieceDate | Date de la pièce |
| 11 | EcritureLib | Libellé de l'écriture |
| 12 | Debit | Montant au débit |
| 13 | Credit | Montant au crédit |
| 14 | EcritureLet | Code de lettrage (A, B… AA…) des lignes lettrées des comptes 411 / 401, unique par compte ; vide sinon |
| 15 | DateLet | Date du lettrage (AAAAMMJJ) ; vide si non lettré |
| 16 | ValidDate | Date de génération de l'écriture : le logiciel n'a pas de mode brouillard, les écritures naissent validées |
| 17 | Montantdevise | Vide (euro uniquement) |
| 18 | Idevise | Vide |

## Limites connues (à porter à la connaissance du vérificateur)
- À-nouveaux : générés à la clôture de l'exercice précédent dans le logiciel (journal AN, premier jour de l'exercice ; comptes de bilan repris par tiers, résultat en 120000 / 129000). Si l'activité a commencé dans un autre outil, les soldes d'ouverture sont à saisir en OD.
- Lettrage : limité aux comptes 411 et 401, au sein d'un même exercice ; un délettrage efface le code (historique au journal d'audit).
- Écritures d'inventaire (amortissements, provisions, régularisations) : saisies manuellement en OD ; paie : hors logiciel.
