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
| Séparation des droits (caissier ≠ clôture) | `permissions.ts` | `security.test.ts` |

## 3. Mécanismes à construire (ordre prévu)

1. **Documents émis inaltérables** : factures, avoirs, règlements, tickets — triggers interdisant toute modification des colonnes financières après émission ; corrections uniquement par avoir / opération inverse.
2. **Données par ticket / règlement** (BOFiP §50) : n° de justificatif, horodatage à la minute, n° de caisse, TTC, détail des lignes (libellé, quantité, PU, HT, taux), mode de paiement, traces des corrections.
3. **Chaînage par document** : empreinte de chaque ticket/règlement chaînée au précédent de la même caisse, en plus du journal d'audit.
4. **Clôtures** journalière, mensuelle, annuelle : grand total de période et **total perpétuel** (jamais remis à zéro, poursuivi lors des mises à jour de version) ; empreinte chaînée de chaque clôture.
5. **Signature** des clôtures et archives par une clé privée (Ed25519) dont la clé publique est publiée ; procédure de gestion et de rotation des clés.
6. **Archivage** annuel / par exercice : format ouvert (JSON + CSV), notice en français, empreinte + signature, événement d'audit ; outil de vérification d'archive livré.
7. **Purge** uniquement après archivage, tracée, sans jamais purger les totaux de clôture.
8. **Restitution** à l'administration : export lisible des données d'origine et des corrections.
9. **Ancrage externe** périodique de la tête de chaîne (horodatage qualifié RFC 3161 ou dépôt chez un tiers) pour une date certaine — à évaluer.

## 4. Limites connues

- Une chaîne de hachage permet de **détecter** une altération, pas de l'**empêcher** : un administrateur de base peut désactiver les triggers et recalculer toute la chaîne. D'où les points 5 et 9 (signature et ancrage externe), et la séparation entre l'administrateur de la base et l'utilisateur.
- PGlite (développement) stocke la base dans un dossier local non chiffré : **jamais** pour un usage réel d'encaissement.
- L'horodatage dépend de l'horloge du serveur (à synchroniser NTP).

## 5. Points à valider avant toute revendication de conformité

- [ ] Lire la version en vigueur du BOFiP (BOI-TVA-DECLA-30-10-30-20260325) et le texte de la LF 2026 sur Légifrance.
- [ ] Choisir la voie : certification (LNE ou Infocert / NF525) ou attestation individuelle de l'éditeur ; obtenir le référentiel correspondant.
- [ ] Établir la matrice exigence par exigence (21 exigences du référentiel LNE v1.6, ou référentiel NF525) avec preuves et tests.
- [ ] Implémenter les points 1 à 8 du §3.
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
