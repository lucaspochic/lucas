# Registre des exigences réglementaires

> **Avertissement.** Ce registre documente l'analyse de l'éditeur du logiciel. Il ne constitue ni un avis juridique ou fiscal, ni une preuve de conformité. **Aucune certification (NF525, LNE ou autre) n'est revendiquée.** À faire relire par un expert-comptable ou un avocat fiscaliste, et par l'organisme certificateur si une certification est visée.

Date de la dernière vérification : **20/10/2026**.
Légende du statut : ✅ implémenté et testé · 🟡 partiellement · ⬜ à faire · ❓ à clarifier.

---

## R1 — Logiciels et systèmes de caisse : conditions ISCA

| | |
|---|---|
| **Source** | CGI, art. 286, I, 3° bis ; BOFiP **BOI-TVA-DECLA-30-10-30** ; page impots.gouv « Quel est le champ d'application de l'obligation de détenir un logiciel de caisse… » |
| **Version** | BOFiP lu : version **20251001**, puis la version en vigueur **BOI-TVA-DECLA-30-10-30-20260325** (§270 à 420 lus le 21/10/2026 : modes de preuve et attestation de l'éditeur, voir docs/06 §7). Page impots.gouv modifiée le 14/10/2026. |
| **Exigence** | Tout assujetti à la TVA qui enregistre les règlements de clients **particuliers** au moyen d'un logiciel doit utiliser un logiciel satisfaisant à des conditions d'**I**naltérabilité, de **S**écurisation, de **C**onservation et d'**A**rchivage. Un logiciel de facturation ou de gestion qui mémorise extra-comptablement les paiements de non-assujettis est concerné **pour cette fonctionnalité** (BOFiP §30-40). |
| **Exemptions** | Franchise en base (art. 293 B CGI), remboursement forfaitaire agricole, opérations exclusivement exonérées, assujettis dont **tous** les paiements passent par intermédiation bancaire (tolérance §35), clientèle exclusivement professionnelle. |
| **Fonctions concernées** | Encaissements (module Paiements) et module Caisse. Le paramétrage du régime (franchise en base) est déjà présent. |
| **Statut** | 🟡 Livré : journal append-only chaîné, documents de vente figés, **règlements en ajout seul, chaînés, idempotents, avec type de payeur (particulier) mémorisé** (itération 4). Clôtures, totaux perpétuels, archives : ⬜ |

### Détail des quatre conditions (BOFiP 20251001, à recouper avec la version 20260325)

| Condition | Exigence (synthèse) | Conception retenue | Statut |
|---|---|---|---|
| Inaltérabilité (§80-120) | Données d'origine non modifiables ; corrections par opérations « plus/moins » elles-mêmes inaltérables ; protection logique **et** protection de bas niveau (empreinte, chaînage…). | Aucune fonction de modification d'un document émis ; triggers PostgreSQL refusant UPDATE/DELETE ; corrections par avoir / contre-passation ; chaînage SHA-256. | 🟡 (audit ✅, documents ⬜) |
| Sécurisation (§130-150) | Procédé fiable empêchant la modification sans trace (chaînage, signature). Mode école / test identifié. | Chaîne de hachage vérifiable (`npm run audit:verify`) ; entreprises de démonstration marquées `is_demo` avec bandeau. **À ajouter** : signature des clôtures par clé privée de l'éditeur ou de l'instance. | 🟡 |
| Conservation (§155-200) | Clôtures **journalière, mensuelle, annuelle** cumulatives ; grand total de période et **total perpétuel** jamais remis à zéro ; conservation 6 ans (LPF art. L. 102 B). Tolérance logiciels de facturation : pas de clôture si le CA d'une période peut être restitué. | Tables `cash_closures` avec totaux cumulés et chaînés ; interdiction de purge des totaux. | ⬜ |
| Archivage (§220-260) | Archive au plus annuelle / par exercice, format ouvert, notice en français, date certaine, traçabilité des archivages et purges ; purge seulement après archive. | Export d'archive (JSON + CSV + notice), empreinte et signature de l'archive, événement d'audit. | ⬜ |

### Mode de preuve de conformité

- LF 2025 (loi n° 2025-127 du 14/02/2025, art. 43) : suppression de l'attestation individuelle de l'éditeur, avec période transitoire jusqu'au 31/08/2026.
- **LF 2026** : rétablit l'attestation individuelle de l'éditeur. La page impots.gouv modifiée le 14/10/2026 indique que la suppression « est donc annulée ». Source secondaire (Légifiscal, 27/03/2026) : art. 125 de la LF 2026, applicable à compter du 21/02/2026 ; actualité BOFiP ACTU-2026-00073 du 25/03/2026. **Numéro d'article à confirmer sur Légifrance** ❓.
- Preuve admise aujourd'hui : **certificat** d'un organisme accrédité (LNE, Infocert pour la marque NF525) **ou attestation individuelle** de l'éditeur.
- Sanction en cas de défaut de justification : amende de l'art. 1770 duodecies du CGI. **Montant non vérifié sur source officielle** ❓ (à lire sur Légifrance).
- Le référentiel de certification LNE (v1.6) indique couvrir le BOI-TVA-DECLA-30-10-30 du 19/05/2021 et comporte 21 exigences ; **non consulté en détail** ❓.

### Tests de vérification (existants)
- `tests/integration/audit-immutability.test.ts` : refus UPDATE/DELETE/TRUNCATE, détection d'altération et de suppression contournant les triggers, numérotation continue sans trou.

---

## R2 — Mentions obligatoires des factures

| | |
|---|---|
| **Source** | CGI art. 242 nonies A (annexe II) ; code de commerce art. L. 441-9, L. 441-10, D. 441-5, R. 123-237 |
| **Exigence** | Numéro unique et chronologique ; date ; identité, adresse, SIREN, n° TVA du vendeur et de l'acheteur ; désignation, quantité, prix unitaire HT, taux et montant de TVA par taux ; réductions ; date de paiement ; pénalités de retard et indemnité forfaitaire de 40 € ; mentions d'exonération (ex. « TVA non applicable, art. 293 B du CGI »). |
| **Fonctions** | Paramètres entreprise (✅) ; moteur de calcul avec motif d'exonération obligatoire à 0 % (✅) ; numérotation continue par type et exercice (✅) ; émission des devis, factures et avoirs (✅ itération 3) : date d'émission = jour de l'émission, copies figées des coordonnées vendeur / client, ventilation de TVA par taux, mentions d'exonération, référence de la facture d'origine sur l'avoir, pénalités et indemnité de 40 € affichées pour les clients professionnels ; contrôles bloquants avant émission (adresse, SIREN, n° TVA, pénalités) ; version imprimable / PDF (✅). |
| **Tests** | `tests/unit/document-totals.test.ts`, `tests/integration/audit-immutability.test.ts`, `tests/integration/sales.test.ts` |
| **Limites** | Le texte exact de l'art. 242 nonies A n'a pas été relu pour cette version ❓. Escompte pour paiement anticipé : mention libre (texte des pénalités). Factures d'acompte : à venir. Le PDF produit n'est pas une facture électronique au sens de la réforme (R4). |

## R3 — Délais de paiement

| | |
|---|---|
| **Source** | Code de commerce art. L. 441-10 |
| **Exigence** | Délai maximal 60 jours à compter de la date d'émission (ou 45 jours fin de mois sur accord). |
| **Fonction** | Validation du délai de paiement (0 à 60 jours) dans `companySchema`. ✅ |
| **Limites** | Les délais dérogatoires sectoriels ne sont pas gérés. |

## R4 — Facturation électronique et e-reporting

| | |
|---|---|
| **Source** | impots.gouv.fr — « Facturation électronique et plateformes agréées », « Je passe à la facturation électronique » (modifiée le 01/09/2026), « J'approfondis mes connaissances sur la réforme » |
| **Exigence** | **Réception** obligatoire pour toutes les entreprises depuis le **01/09/2026** ; **émission + e-reporting** au 01/09/2026 pour GE/ETI et au **01/09/2027** pour PME et micro-entreprises. Échanges via une **plateforme agréée** ; formats **UBL, CII** ou format mixte (données structurées + image). Nouvelles mentions : SIREN du client, catégorie d'opération (biens / services / mixte), option TVA sur les débits, adresse de livraison si différente. |
| **Fonctions** | Option TVA sur débits (✅ paramètre). SIREN client, adresse de livraison distincte, nature bien / service des articles : présents dans les tiers et le catalogue (✅, itération 2) ; report sur les factures (⬜). Export Factur-X / UBL / CII (⬜). Connecteur plateforme agréée (⬜ — **dépendance externe** : contrat et API d'une plateforme immatriculée). |
| **Limites** | Spécifications externes B2B non lues ❓ ; Factur-X n'est pas nommé explicitement dans les pages lues (format « mixte ») ❓. Un PDF seul ne suffit pas. |

## R5 — Conservation des documents et données

| | |
|---|---|
| **Source** | LPF art. L. 102 B (6 ans, fiscal) ; code de commerce art. L. 123-22 (10 ans, pièces comptables) |
| **Exigence** | Conservation des factures et données d'encaissement 6 ans (fiscal) ; documents comptables 10 ans. |
| **Conception** | Aucune suppression physique des données financières validées (contraintes `ON DELETE RESTRICT`, triggers) ; purge uniquement des données techniques (sessions, tentatives de connexion > 30 jours). |
| **Statut** | 🟡 |
| **Limites** | Art. L. 123-22 non relu pour cette version ❓. |

## R6 — Fichier des écritures comptables (FEC) et intangibilité des écritures

| | |
|---|---|
| **Source** | LPF art. L. 47 A-I et A. 47 A-1 (Légifrance LEGIARTI000027804775, en vigueur depuis le 02/08/2013) ; BOFiP BOI-CF-IOR-60-40-20-20170607. Lus le 21/10/2026. |
| **Exigence** | 18 zones dans l'ordre réglementaire ; séparateur tabulation ou « \| » ; dates AAAAMMJJ ; virgule décimale sans séparateur de milliers ; jeux de caractères ASCII, ISO 8859-15 ou UTF-8 ; nom `SirenFECAAAAMMJJ` (date de clôture) ; écritures classées par ordre chronologique de validation ; numérotation continue (unique sur le fichier ou par journal, à documenter) ; descriptif du fichier obligatoire. |
| **Fonctions** | Écritures générées automatiquement et validées dès leur création (pas de brouillard), en ajout seul, équilibre contrôlé par la base ; numéro d'écriture unique et continu par exercice ; export FEC conforme au format ci-dessus (✅ itération 6) ; descriptif : `docs/13-fec-descriptif.md`. Itération 8 : lettrage 411/401 (EcritureLet, DateLet), clôture d'exercice définitive avec à-nouveaux (journal AN, placés en tête du fichier), exercice clos verrouillé en base, saisie d'OD pour les écritures d'inventaire. |
| **Tests** | `tests/integration/accounting.test.ts` (format, nom, 18 zones, dates, montants, ordre, équilibre, continuité, droits) ; `tests/integration/accounting-closing.test.ts` (lettrage, clôture, à-nouveaux, verrouillage, saisie OD, TVA). |
| **Limites** | Écritures d'inventaire non automatisées (saisie OD). Placement des à-nouveaux en tête du fichier alors que leur numéro peut être postérieur à des écritures déjà validées de l'exercice : interprétation à faire confirmer ❓. Montantdevise et Idevise restent vides (euro uniquement). Le BOFiP n'a été lu intégralement que pour sa première moitié ❓. Le fichier n'a pas encore été soumis à l'outil de test de l'administration (« Test Compta Demat ») ❓. |

## R7 — RGPD et sécurité des données

| | |
|---|---|
| **Source** | Règlement (UE) 2016/679 (art. 5, 25, 32) ; recommandations CNIL sur les mots de passe |
| **Exigence** | Minimisation, sécurité adaptée, protection dès la conception, durées de conservation définies. |
| **Fonctions** | Hachage scrypt ; jetons de session stockés hachés ; e-mail haché dans la table des tentatives ; purge des données techniques ; pas d'e-mail en clair dans les journaux techniques ; isolation par entreprise (✅ testée). MFA ⬜, registre des traitements ⬜, export / effacement des données personnelles ⬜. |
| **Limites** | Recommandation CNIL mots de passe (délibération 2022-100) non relue pour cette version ❓ : longueur minimale 12 retenue par prudence. |

---

## Sources consultées le 20/10/2026

- impots.gouv.fr — [Champ d'application de l'obligation de détenir un logiciel de caisse](https://www.impots.gouv.fr/professionnel/questions/quel-est-le-champ-dapplication-de-lobligation-de-detenir-un-logiciel-de)
- BOFiP — [BOI-TVA-DECLA-30-10-30-20251001](https://bofip.impots.gouv.fr/bofip/10691-PGP.html/identifiant=BOI-TVA-DECLA-30-10-30-20251001)
- BOFiP — [ACTU-2025-00075 (LF 2025, art. 43)](https://bofip.impots.gouv.fr/bofip/14667-PGP.html/ACTU-2025-00075)
- Légifiscal (source secondaire) — [LF 2026 : rétablissement de l'auto-certification](https://www.legifiscal.fr/actualites-fiscales/4460-loi-finances-2026-retablissement-auto-certification-logiciels-caisse.html)
- impots.gouv.fr — [Facturation électronique et plateformes agréées](https://www.impots.gouv.fr/facturation-electronique-et-plateformes-agreees)
- LNE — [Fiche certification des systèmes de caisse](https://www.lne.fr/sites/default/files/bloc-telecharger/certification-systemes-caisse-fiche-LNE.pdf) (non lue en détail)

## À lire avant la prochaine itération
1. BOI-TVA-DECLA-30-10-30-20260325 (version en vigueur).
2. Texte de la LF 2026 sur Légifrance (article modifiant le 3° bis du I de l'art. 286) et art. 1770 duodecies CGI.
3. Référentiel LNE v1.6 (21 exigences) ou référentiel NF525 d'Infocert, selon le certificateur retenu.
4. Spécifications externes B2B de la facturation électronique.
5. Art. 242 nonies A annexe II CGI, art. A. 47 A-1 LPF (FEC).
