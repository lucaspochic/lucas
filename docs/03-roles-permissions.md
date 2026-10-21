# Matrice des rôles et permissions

Source de vérité : `src/server/security/permissions.ts`. Testée par `tests/unit/security.test.ts` et `tests/integration/companies-isolation.test.ts`.

| Permission | Propriétaire | Administrateur | Comptable | Commercial | Caissier | Lecture seule |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| company.read — voir les paramètres | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| company.update — modifier les paramètres | ✓ | ✓ | | | | |
| members.read — voir les membres | ✓ | ✓ | ✓ | | | |
| members.manage — ajouter / changer les rôles | ✓ | ✓ | | | | |
| audit.read — consulter le journal d'audit | ✓ | ✓ | ✓ | | | |
| audit.verify — vérifier l'intégrité | ✓ | ✓ | ✓ | | | |
| thirdparties.read / write | ✓ / ✓ | ✓ / ✓ | ✓ / – | ✓ / ✓ | ✓ / – | ✓ / – |
| catalog.read / write | ✓ / ✓ | ✓ / ✓ | ✓ / – | ✓ / ✓ | ✓ / – | ✓ / – |
| sales.read / write | ✓ / ✓ | ✓ / ✓ | ✓ / – | ✓ / ✓ | | ✓ / – |
| sales.issue — émettre factures et avoirs | ✓ | ✓ | | ✓ | | |
| payments.write — enregistrer un règlement | ✓ | ✓ | ✓ | ✓ | | |
| accounting.read / write | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ | ✓ / – | | ✓ / – |
| purchases.read / write — dépenses fournisseurs | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ | | | ✓ / – |
| treasury.read / write — comptes, relevés, rapprochement | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ | | | ✓ / – |
| accounting.close — clôturer un exercice | ✓ | | ✓ | | | |
| cash.operate — encaisser en caisse | ✓ | ✓ | | | ✓ | |
| cash.close — clôturer la caisse | ✓ | ✓ | | | | |
| exports.run — exports comptables / FEC | ✓ | ✓ | ✓ | | | |

## Règles complémentaires (implémentées dans les services)
- Seul un propriétaire peut nommer ou rétrograder un propriétaire.
- Une entreprise conserve toujours au moins un propriétaire.
- Un utilisateur ne peut pas modifier son propre rôle depuis l'interface.
- Toute modification de rôle est inscrite au journal d'audit.

## Hypothèse
Le caissier ne clôture pas la caisse lui-même (séparation des tâches). À ajuster selon les besoins des commerces visés.
