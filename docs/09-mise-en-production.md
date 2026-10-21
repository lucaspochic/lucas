# Checklist de mise en production

## Bloquant — à faire avant toute utilisation réelle
- [x] Modules métier minimum livrés : facturation, règlements, dépenses, trésorerie, comptabilité, caisse (itérations 3 à 7).
- [ ] Générer les secrets (`npm run cash:keygen`) et les placer dans le fichier `--env-file` : `GESTION_CASH_SIGNING_KEY` (signature de caisse ; **conserver la clé publique** affichée) et `GESTION_APP_ENCRYPTION_KEY` (chiffrement des secrets de double authentification). Ces clés ne doivent jamais être perdues ni divulguées : prévoir leur sauvegarde chiffrée, séparée de celle de la base.
- [x] Image Docker construite et testée ; `docker compose up` validé le 20/10/2026 (migrations, santé, en-têtes, triggers, inscription désactivée).
- [ ] Lancer avec un fichier dédié : `docker compose --env-file .env.production up -d --build` (le `.env` de développement est lu automatiquement sinon).
- [ ] Créer le premier compte : `docker compose run --rm migrate node_modules/.bin/tsx scripts/create-user.ts e-mail "Nom"`.
- [ ] Intégration continue : `.github/workflows/ci.yml` (typage, lint, tests PGlite, tests PostgreSQL 17, build, parcours de bout en bout Playwright) — à confirmer au premier passage sur GitHub.
- [x] Tests de concurrence exécutés sur PostgreSQL 17 serveur (`TEST_POSTGRES_URL`) : numérotation (20/10/2026), suite complète dont tickets de caisse simultanés (21/10/2026, 185/185).
- [ ] HTTPS obligatoire (reverse proxy), `APP_ENV=production` (cookies Secure, `__Host-`).
- [ ] `ALLOW_SELF_SIGNUP=false` sauf offre en libre-service assumée.
- [ ] Secrets dans un gestionnaire de secrets ; aucun `.env` dans l'image.
- [ ] Utilisateur PostgreSQL applicatif **sans** droit `ALTER TABLE` / `DISABLE TRIGGER` (migrations jouées avec un autre rôle).
- [ ] Sauvegardes chiffrées actives sur l'hébergement retenu ; restauration testée localement le 21/10/2026 (`docs/08`), à refaire sur l'hébergement.
- [ ] Supervision : `/api/health`, collecte des journaux JSON, alertes erreurs, `npm run audit:verify` planifié.
- [ ] Horloge serveur synchronisée (NTP), fuseau UTC.
- [ ] Revue de sécurité / test d'intrusion.
- [ ] RGPD : registre des traitements, politique de confidentialité, contrat de sous-traitance (art. 28) avec les clients, hébergeur situé dans l'UE.
- [ ] Mentions dans l'interface et les CGV : aucune revendication de certification non obtenue.

## Réglementaire
- [ ] Points du `docs/06-conformite-caisse-nf525.md` §5.
- [ ] Facturation électronique : choix d'une plateforme agréée partenaire, formats UBL/CII/Factur-X.
- [ ] Relecture des règles de calcul et des mentions par un expert-comptable.

## Procédure de déploiement d'une version
1. Sauvegarde de la base.
2. `npm run db:migrate` (rôle migrations).
3. Déploiement de l'application.
4. Contrôle `/api/health`, connexion, `npm run audit:verify`.
5. Retour arrière : redéployer l'image précédente ; les migrations sont conçues pour être additives (jamais de suppression de colonne financière).
