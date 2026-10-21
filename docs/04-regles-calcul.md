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
6. **Acomptes** (itération 11) : une facture d'acompte reprend un pourcentage de chaque base HT du devis (par taux et par nature), arrondi au centime ; elle est numérotée dans la suite des factures. La **facture de solde** reprend toutes les lignes du devis et déduit chaque acompte émis (net de ses avoirs) par une **ligne négative au même taux**, exclue de la remise globale : base HT et TVA du solde sont diminuées de ce qui a déjà été facturé. Les déductions sont recalculées à l'émission (un acompte émis entre-temps est repris). Le cumul des acomptes ne peut dépasser le TTC du devis ; aucun acompte après la facture de solde.
   Comptabilisation : HT des acomptes en 419100 (soldé par la facture de solde) ; TVA des prestations selon la règle habituelle (encaissement, ou débits sur option) ; TVA des acomptes sur **biens** en 445800 « en attente de livraison » (un acompte ne rend pas exigible la TVA d'une livraison de biens, CGI art. 269), reprise par la facture de solde. **Schéma à valider avec un expert-comptable.**
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

## 8. Tableau de bord (itération 5)
- **Chiffre d'affaires HT** : Σ HT des factures émises − Σ HT des avoirs émis dont la date d'émission est dans la période. Brouillons et devis exclus.
- **Encaissements** : Σ des règlements (encaissements − remboursements ± contre-passations) dont la date de paiement est dans la période.
- **Créances clients** (à date) : Σ des restes à payer positifs (TTC − avoirs − réglé) des factures émises.
- **Factures en retard** : créances dont l'échéance est dépassée.
- **TVA collectée (estimation)** : Σ TVA des factures − Σ TVA des avoirs émis dans la période. Pour les prestations sans option sur les débits, la TVA est exigible à l'encaissement : estimation à valider avec la déclaration.
- **Dépenses** : Σ HT des dépenses validées dont la date de facture est dans la période.
- **Trésorerie disponible (comptable)** : Σ (ouverture + règlements clients − paiements fournisseurs) des comptes de trésorerie.
- **Prévision** : créances et dépenses à payer dont l'échéance tombe dans l'horizon (échus inclus).
- Dépenses : TVA de la facture fournisseur acceptée si l'écart avec la TVA calculée est ≤ max(0,05 €, 1 %).
