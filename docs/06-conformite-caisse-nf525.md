# Conformité caisse (art. 286 I 3° bis CGI) — conception et points restant à valider

> **Ce logiciel n'est ni certifié NF525, ni certifié LNE, et aucune attestation éditeur n'a été émise.** Ce document décrit la conception visant à permettre une future certification ou attestation, et liste ce qui reste à faire.

## 1. Périmètre fonctionnel : quoi est soumis à quoi

| Fonction | Nature | Obligation ISCA ? |
|---|---|---|
| Paramétrage, tiers, catalogue, devis | Gestion commerciale | Non |
| Factures et avoirs B2B | Facturation | Non au titre de l'art. 286 I 3° bis (règles de facturation et d'intangibilité comptable s'appliquent) |
| Enregistrement d'un règlement d'un client **particulier** | Encaissement extra-comptable | **Oui** (BOFiP §30-40) |
| Module caisse (tickets, sessions, clôtures) | Logiciel de caisse | **Oui** |
| Comptabilité (écritures validées) | Comptabilité | Intangibilité (art. L. 47 A LPF, FEC) ; écritures en mode « brouillard » modifiables = soumises à l'obligation (§30) |

Conséquence de conception : **toute** fonction qui mémorise un paiement de non-assujetti est construite selon les exigences ISCA, y compris dans le module de facturation.

## 2. Mécanismes déjà en place

| Mécanisme | Emplacement | Test |
|---|---|---|
| Journal d'audit append-only, chaîné SHA-256 par entreprise | `src/server/services/audit.ts` | `audit-immutability.test.ts` |
| Triggers PostgreSQL refusant UPDATE / DELETE / TRUNCATE sur le journal | `drizzle/0001_*.sql` | idem |
| Détection d'altération contournant les triggers (désactivation par un DBA) | `verifyAuditChain` | idem |
| Vérification en ligne de commande (supervision) | `npm run audit:verify` (code 2 si altération) | manuel |
| Numérotation continue, sans trou, sans réutilisation | `src/server/services/sequences.ts` | idem |
| Données de démonstration marquées et signalées par un bandeau (mode « école ») | `companies.is_demo` | — |
| Séparation des droits (caissier ≠ clôture) | `permissions.ts` | `security.test.ts`, `cash.test.ts` |
| Module caisse : tickets, lignes, paiements, clôtures, archives en ajout seul (triggers) | `drizzle/0012_cash_guards.sql` | `cash.test.ts` |
| Tickets numérotés en continu par caisse (`C1-000001`), chaînés SHA-256, verrou par caisse | `src/server/services/cash.ts` | `cash.test.ts` (dont 8 tickets simultanés sur PostgreSQL 17) |
| Corrections par ticket de remboursement lié, motif obligatoire, jamais au-delà du vendu | `refundTicket` | idem |
| Mode école : tickets chaînés, marqués, exclus des totaux et de la comptabilité | `cash_tickets.training` | idem |
| Clôtures journalières (automatiques au premier ticket du jour suivant, ou manuelles), mensuelles et annuelles ; chaînées et signées Ed25519 | `closeDuePeriods`, `src/server/security/signing.ts` | idem |
| Archive ZIP au format ouvert (CSV + JSON), notice en français, manifeste signé, clé publique jointe ; fonction de vérification | `exportArchive`, `verifyArchive` | idem |
| Contrôle d'intégrité des caisses (écran + `npm run audit:verify`) | `verifyRegister` | idem |
| Comptabilisation automatique (journal VC ; écarts de caisse en 658/758) | `postCashTicket`, `postCashDifference` | idem |

## 3. Mécanismes : état au 21/10/2026

1. ✅ **Documents émis inaltérables** : factures, avoirs, règlements, tickets — corrections uniquement par avoir, opération inverse ou remboursement lié.
2. ✅ **Données par ticket / règlement** (BOFiP §50) : n° de justificatif, horodatage (à la seconde, UTC), n° de caisse, TTC, détail des lignes (libellé, nature, quantité, PU TTC, taux), mode de paiement, ticket d'origine et motif des corrections.
3. ✅ **Chaînage par document** : règlements chaînés par entreprise ; tickets et clôtures chaînés par caisse ; en plus du journal d'audit.
4. ✅ **Clôtures** journalière, mensuelle, annuelle (par exercice) : grand total de période, **total perpétuel** jamais remis à zéro, cumul des valeurs absolues ; empreinte chaînée.
5. 🟡 **Signature** Ed25519 des clôtures et archives ✅ ; clé de production `CASH_SIGNING_KEY` (`npm run cash:keygen`). Reste : procédure écrite de garde et de rotation ; conservation des clés publiques successives (le contrôle en ligne ne vérifie aujourd'hui que les signatures de la clé courante ; les archives embarquent leur clé publique).
6. 🟡 **Archivage** ✅ à la demande, pour toute période dont les journées sont clôturées (refus sinon), tracé (table `cash_archives` + audit). Reste : archivage annuel automatique et procédure de conservation hors base (6 ans).
7. ⬜ **Purge** : aucune purge n'existe (données conservées sans limite) ; à concevoir si besoin, uniquement après archivage.
8. 🟡 **Restitution** : archive ZIP et écrans de tickets (données d'origine et corrections). Reste : documentation utilisateur.
9. ⬜ **Ancrage externe** périodique de la tête de chaîne (horodatage qualifié RFC 3161 ou dépôt chez un tiers) — à évaluer.

## 4. Limites connues

- Une chaîne de hachage permet de **détecter** une altération, pas de l'**empêcher** : un administrateur de base peut désactiver les triggers et recalculer toute la chaîne. D'où les points 5 et 9 (signature et ancrage externe), et la séparation entre l'administrateur de la base et l'utilisateur.
- PGlite (développement) stocke la base dans un dossier local non chiffré : **jamais** pour un usage réel d'encaissement.
- L'horodatage dépend de l'horloge du serveur (à synchroniser NTP). La date de rattachement d'un ticket est la date civile à Paris.
- L'archive mentionne l'opérateur par son identifiant interne (UUID) ; la correspondance avec le nom est dans la base.
- En développement, la clé de signature est générée dans `.data/keys/` (non versionné) : ne jamais l'utiliser en production.

## 5. Points à valider avant toute revendication de conformité

- [ ] Lire la version en vigueur du BOFiP (BOI-TVA-DECLA-30-10-30-20260325) et le texte de la LF 2026 sur Légifrance.
- [ ] Choisir la voie : certification (LNE ou Infocert / NF525) ou attestation individuelle de l'éditeur ; obtenir le référentiel correspondant.
- [ ] Établir la matrice exigence par exigence (21 exigences du référentiel LNE v1.6, ou référentiel NF525) avec preuves et tests.
- [ ] Terminer les points 5 à 9 du §3 (rotation des clés, archivage annuel, purge, ancrage).
- [ ] Définir ce qu'est une « version majeure » (déclenche le renouvellement du certificat) et la politique de versionnement.
- [ ] Documenter l'hébergement : qui administre la base, journalisation des accès d'administration, sauvegardes.
- [ ] Faire auditer la conception (certificateur, conseil fiscal).
- [ ] Vérifier le montant et les conditions de l'amende de l'art. 1770 duodecies CGI pour l'information des clients.
- [ ] Rédiger la documentation utilisateur des clôtures et de l'archivage.

## 6. Décisions validées par le porteur du projet (20/10/2026)

- **Les entreprises clientes vendent à des particuliers** : le module de règlements et le module caisse sont dans le champ de l'art. 286 I 3° bis CGI et seront conçus selon les quatre conditions ISCA.
- **« ISCA » = Inaltérabilité, Sécurisation, Conservation, Archivage** (confirmé).
- Conséquence déjà implémentée : chaque tiers porte un type (particulier / professionnel / organisme public), qui permettra de déterminer les règlements soumis à ces obligations.
- Reste à décider : certification par un organisme accrédité **ou** attestation individuelle de l'éditeur.

## 7. Attestation individuelle de l'éditeur — état du droit vérifié le 21/10/2026

Source : BOFiP BOI-TVA-DECLA-30-10-30-20260325 (en vigueur depuis le 25/03/2026), §270 à §420.

- **Mode de preuve alternatif au certificat** (§270) : certificat d'un organisme accrédité **ou** attestation individuelle de l'éditeur, rétablie à compter du 21/02/2026 par l'article 125 de la loi n° 2026-103 du 19/02/2026 de finances pour 2026. Un seul des deux suffit ; ce n'est pas un régime transitoire.
- **Délivrée par l'éditeur** (§300, §365) : la personne qui détient le code source et maîtrise les paramètres ; signée par son représentant légal (§370).
- **Nominative**, à chaque client assujetti (§370) ; une mention dans les CGV ne vaut pas attestation. Document pré-rempli remis à l'achat admis, complété par le client.
- **Contenu obligatoire** (§375) : mention explicite du respect des quatre conditions ; nom, références et version du logiciel (n° de licence s'il existe) ; date d'acquisition. **Conforme au modèle BOI-LETTRE-000242** (§390) — modèle non encore lu ❓.
- **Par version majeure** (§380) : nouvelle attestation à chaque version majeure (version modifiant un paramètre qui touche aux quatre conditions, §340). Politique de versionnement à définir.
- **Auto-attestation exclue** (§375) sauf activité réelle d'édition de logiciels ; un logiciel développé pour ses propres besoins exige un certificat.
- **Responsabilité** (§300) : l'attestation engage l'éditeur. **Faux document** (§400) : art. 441-1 du code pénal, 3 ans d'emprisonnement et 45 000 € d'amende, y compris pour l'assujetti qui présente sciemment une fausse attestation. Défaut de justification : amende de l'art. 1770 duodecies CGI (§420 ; montant non vérifié ❓).
- **Certification en cours** : le texte ne prévoit rien de particulier.

**Conséquence pour ce logiciel** : une attestation ne pourra être délivrée qu'une fois les quatre conditions effectivement remplies (module caisse : clôtures, totaux perpétuels, archivage — non encore réalisés) et le dossier de preuves constitué. La délivrer avant serait une attestation inexacte.
