# Checklist de mise en production

## Bloquant — à faire avant toute utilisation réelle
- [ ] Modules métier minimum livrés (facturation, règlements) — **non livrés à ce jour**.
- [ ] Image Docker construite et testée ; `docker compose up` validé.
- [ ] CI active (typage, lint, tests, migrations sur PostgreSQL réel, build).
- [ ] Tests de concurrence (numérotation, règlements) exécutés sur PostgreSQL serveur.
- [ ] HTTPS obligatoire (reverse proxy), `APP_ENV=production` (cookies Secure, `__Host-`).
- [ ] `ALLOW_SELF_SIGNUP=false` sauf offre en libre-service assumée.
- [ ] Secrets dans un gestionnaire de secrets ; aucun `.env` dans l'image.
- [ ] Utilisateur PostgreSQL applicatif **sans** droit `ALTER TABLE` / `DISABLE TRIGGER` (migrations jouées avec un autre rôle).
- [ ] Sauvegardes chiffrées actives et **restauration testée** (`docs/08`).
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
