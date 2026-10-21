# Conception — module comptable (itérations 6 et 8)

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
| VC | Ventes caisse | tickets de caisse et remboursements |
| OD | Opérations diverses | transfert de TVA sur encaissements, écarts de caisse, saisies manuelles |
| AN | À-nouveaux | reprise des soldes à la clôture de l'exercice précédent |

## Schémas d'écritures
| Événement | Débit | Crédit |
|---|---|---|
| Facture émise | 411000 (auxiliaire client) TTC | 706000 prestations / 707000 marchandises (HT par nature) ; 44571x TVA collectée (ou 445740 « TVA en attente » pour les prestations sans option sur les débits) |
| Avoir émis | inverse de la facture | |
| Facture d'acompte | 411000 TTC | 419100 HT ; TVA des prestations comme une facture ; TVA des biens en 445800 (en attente de livraison) |
| Facture de solde | 411000 TTC net des acomptes ; 419100 (HT des acomptes déduits) ; 445800 (TVA des acomptes sur biens) | 706 / 707 HT total ; TVA totale (biens exigible, prestations selon l'option) diminuée de la TVA des prestations déjà facturée en acompte |
| Encaissement | 512xxx / 530000 | 411000 (auxiliaire) |
| Remboursement, contre-passation | inverse | |
| Encaissement sur prestations sans option débits | OD : 445740 | 44571x (quote-part de TVA encaissée ; solde à l'encaissement complet) |
| Dépense validée | 6xxxxx / 2xxxxx HT par ligne ; 445660 TVA déductible (445620 sur immobilisations) | 401000 (auxiliaire fournisseur) TTC |
| Paiement fournisseur | 401000 (auxiliaire) | 512xxx / 530000 |

Entreprise en **franchise en base** : pas de TVA collectée ; la TVA des fournisseurs, non récupérable, s'ajoute à la charge.

## Restitutions
Journal, grand livre (avec solde progressif), balance générale, échéancier clients / fournisseurs, **export FEC** (art. A. 47 A-1 du LPF : 18 zones, séparateur tabulation, dates AAAAMMJJ, montants à virgule, fichier `SIRENFECAAAAMMJJ.txt`).

## Travaux de fin de période (itération 8)

**Lettrage** (comptes 411 et 401). Les lignes d'écriture restant intangibles, le lettrage est porté par `letterings` / `lettering_lines`. Règles : lignes d'un même compte, d'un même tiers et d'un même exercice, de solde nul (contrôle différé en base) ; code A, B… AA… attribué dans l'ordre par compte et jamais réutilisé ; délettrage tracé. Lettrage automatique, au sein de chaque exercice : (0) contre-passation ↔ règlement annulé ; (1) groupes reliés par les pièces (facture ↔ règlements imputés, avoir ↔ facture, dépense ↔ paiements) de solde nul ; (2) par tiers, ensemble des lignes restantes de solde nul.

**Clôture d'exercice** (permission `accounting.close` : propriétaire, comptable). Contrôles : exercice terminé ; exercices antérieurs clôturés ; écritures équilibrées ; numérotation continue ; journées de caisse de l'exercice clôturées. Effets : écriture d'à-nouveaux au premier jour de l'exercice suivant (classes 1 à 5 reprises par compte et par tiers, résultat en 120000 bénéfice / 129000 perte, en attente d'affectation) ; enregistrement définitif (`fiscal_year_closures`, ajout seul) ; toute écriture sur l'exercice est ensuite refusée par le service **et** par un trigger. Aucune réouverture.

**Saisie d'opérations diverses** : écritures d'inventaire, affectation du résultat, corrections ; équilibrée, validée dès l'enregistrement, idempotente, refusée sur un exercice clos, auditée. Un compte absent du plan est créé avec l'intitulé saisi ; le tiers doit exister.

**Aide à la déclaration de TVA** : par mois ou trimestre de l'exercice, depuis les écritures hors à-nouveaux : TVA collectée exigible par taux (44571x, base HT reconstituée), déductible sur biens et services (445660) et immobilisations (445620), solde dû ou crédit, TVA en attente (44574x) pour information. Ce n'est pas une déclaration : aucun numéro de ligne du formulaire n'est affecté.

## Hors périmètre (documenté)
Écritures d'inventaire automatiques (immobilisations et plan d'amortissement, stocks), télédéclaration de TVA, régimes particuliers (autoliquidation, intracommunautaire, régularisations), paie, lettrage des comptes autres que 411 / 401.
