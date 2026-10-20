# Règles de calcul financier

Implémentation : `src/server/domain/money.ts`, `src/server/domain/document-totals.ts`.
Tests : `tests/unit/document-totals.test.ts`.

## 1. Représentation des montants

| Donnée | Type base | Échelle | Type TypeScript |
|---|---|---|---|
| Montants (HT, TVA, TTC, règlements) | `numeric(15,2)` | 2 | chaîne décimale → `Decimal` |
| Prix unitaires HT | `numeric(15,4)` | 4 | idem |
| Quantités | `numeric(15,3)` | 3 | idem |
| Taux (TVA, remise) | `numeric(5,2)` | 2 | idem |

- Aucun `number` JavaScript non entier n'est accepté pour un montant (`dec()` lève une erreur).
- Arrondi : **ROUND_HALF_UP symétrique** (0,005 → 0,01 ; −0,005 → −0,01), au centime.
- Les montants calculés sont **toujours recalculés côté serveur** ; ceux envoyés par le navigateur sont ignorés.

## 2. Totaux d'un document

1. **Ligne** : `HT ligne = arrondi(quantité × PU HT × (100 − remise ligne %) / 100)`.
2. **Remise globale** : `HT ligne net = arrondi(HT ligne × (100 − remise globale %) / 100)`, ligne par ligne, afin de ventiler exactement la remise par taux de TVA.
3. **Regroupement** par couple (taux, motif d'exonération).
4. **TVA par taux** : `TVA = arrondi(Σ HT nets du taux × taux / 100)`. Méthode « par taux », la plus répandue et conforme à la présentation exigée (montant de TVA par taux).
5. **TTC** = Σ bases HT + Σ TVA. Invariant testé : HT + TVA = TTC exactement, Σ HT lignes = HT total.
6. **Acomptes** : le TTC des factures d'acompte est déduit du **net à payer** ; la TVA de la facture de solde reste calculée sur la totalité, la TVA déjà collectée sur l'acompte étant régularisée lors de la comptabilisation (à implémenter avec le module comptable — hypothèse à valider avec un expert-comptable).
7. **Taux 0 %** : un motif d'exonération est obligatoire (ex. « TVA non applicable, art. 293 B du CGI », « Autoliquidation », « Exonération de TVA, art. 262 ter I du CGI »).
8. **Avoirs** : quantités négatives ; l'arrondi symétrique garantit qu'un avoir total annule exactement la facture d'origine.

## 3. Prix TTC de catalogue
`TTC = arrondi(PU HT × (100 + taux) / 100)` — affichage uniquement ; la facture applique toujours la méthode §2.

## 4. Taux de TVA par défaut (France métropolitaine)
20 % (normal), 10 % (intermédiaire), 5,5 % (réduit), 2,1 % (particulier). Entreprise en franchise en base : un unique taux 0 % avec la mention art. 293 B. Les taux DOM (8,5 %, 2,1 %…) et la Corse ne sont pas créés par défaut : à ajouter par l'utilisateur ⚠ hypothèse.

## 5. Numérotation
Format `PRÉFIXE-EXERCICE-NNNNN` ; une série continue par (entreprise, type de document, exercice). Attribution dans la transaction d'émission, sous verrou de ligne ; une transaction annulée ne consomme pas de numéro.

## 6. Exercice
L'exercice d'une date est désigné par l'année de sa clôture : début au 1er juillet → le 01/07/2026 appartient à l'exercice 2027. Les dates légales sont évaluées dans le fuseau Europe/Paris.

## 7. Documents de vente (itération 3)
- Les montants d'un **avoir** sont enregistrés en **valeurs positives** ; le sens (diminution du chiffre d'affaires et de la TVA collectée) est porté par le type `credit_note`. Tout agrégat (chiffre d'affaires, TVA, encours) doit donc retrancher les avoirs émis.
- Le total HT d'une ligne est stocké **avant** remise globale ; la remise globale est appliquée par le moteur de calcul ligne par ligne puis regroupée par taux (§2). Le document affiche « Total lignes HT », « Remise globale », « Total HT ».
- Cumul des avoirs d'une facture ≤ total TTC de la facture (contrôle à l'émission, sous verrou de la facture d'origine).
- Échéance d'une facture = date d'émission + délai du client (à défaut, délai de l'entreprise) ; validité d'un devis : 30 jours.
