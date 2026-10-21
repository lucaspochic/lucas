# Sauvegarde et restauration

> **Statut : procédure rédigée, NON TESTÉE** (PostgreSQL serveur non disponible sur le poste initial). Un test de restauration complet est obligatoire avant la mise en production, puis au moins trimestriellement.

## Production (PostgreSQL)

### Sauvegarde quotidienne chiffrée
```bash
pg_dump --format=custom --no-owner "$DATABASE_URL" \
  | age -r "$CLE_PUBLIQUE_SAUVEGARDE" > "gestion-$(date +%F).dump.age"
```
- Chiffrement asymétrique ([age](https://age-encryption.org)) : le serveur ne détient que la clé publique ; la clé privée est conservée hors ligne.
- Copie hors site (stockage objet, autre région), rétention : 30 sauvegardes quotidiennes + 12 mensuelles. Les obligations de conservation (6 et 10 ans) sont assurées par les **archives** légales, pas par les sauvegardes.
- Pour un RPO inférieur à 24 h : archivage continu des WAL (pgBackRest ou service managé).

### Pièces jointes et secrets
La base ne contient que les métadonnées des pièces jointes : leur contenu est dans le volume `attachments` (`ATTACHMENTS_DIR`). Il doit être sauvegardé **avec** la base, au même rythme :
```bash
docker run --rm -v gestion_attachments:/data:ro -v "$PWD":/out alpine \
  tar -C /data -czf /out/pieces-jointes-$(date +%F).tar.gz .
# puis chiffrer avec age comme le dump
```
Les fichiers sont nommés par leur empreinte SHA-256 et ne sont jamais modifiés : une sauvegarde incrémentale (rsync, restic) convient. À la lecture, l'application recalcule l'empreinte et refuse un fichier altéré.

Les clés `CASH_SIGNING_KEY` et `APP_ENCRYPTION_KEY` sont sauvegardées **séparément** (coffre de secrets) : sans `APP_ENCRYPTION_KEY`, les secrets de double authentification sont illisibles (chaque utilisateur devra être réinitialisé avec `npm run user:reset-mfa`).

### Restauration
```bash
age -d -i cle-privee.txt gestion-AAAA-MM-JJ.dump.age > gestion.dump
createdb gestion_restauree
pg_restore --no-owner --dbname=gestion_restauree gestion.dump
DATABASE_URL=postgres://…/gestion_restauree npm run audit:verify   # doit sortir avec le code 0
```
Puis : démarrer l'application sur la base restaurée, se connecter, contrôler les derniers documents.

### Contrôles après restauration
1. `npm run audit:verify` : toutes les chaînes intègres.
2. Comparer la tête de chaîne de chaque entreprise avec la dernière valeur relevée par la supervision.
3. Vérifier les compteurs de numérotation (`document_sequences`) : aucun recul.

> Une restauration fait revenir la base à un état antérieur. Les documents émis après la sauvegarde sont perdus et leurs numéros pourraient être réattribués : **procédure d'incident** à documenter (constat, ré-émission sous de nouveaux numéros, information du comptable).

## Développement (PGlite)
La base est le dossier `.data/pglite`. Sauvegarde : arrêter l'application, copier le dossier. Aucune donnée réelle ne doit y être stockée.
