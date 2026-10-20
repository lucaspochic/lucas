# Sécurité

| Menace | Mesure | Où | Testé |
|---|---|---|---|
| Vol de base → mots de passe | scrypt N=2^17, r=8, p=1, sel 16 octets ; rehash automatique si paramètres renforcés | `security/password.ts` | ✅ |
| Vol de base → sessions | Seule l'empreinte SHA-256 du jeton est stockée | `services/auth.ts` | ✅ |
| Force brute | 5 échecs / 15 min par e-mail, 30 par IP ; message générique ; temps de réponse homogène (hash factice) | `services/auth.ts` | ✅ |
| Énumération de comptes à la connexion | Message d'erreur identique | idem | ✅ |
| Vol de cookie | HttpOnly, SameSite=Lax, Secure + préfixe `__Host-` en production | `http/session.ts` | — |
| Session persistante après changement de mot de passe | Révocation de toutes les sessions | `changePassword` | ✅ |
| CSRF | Server Actions : contrôle de l'en-tête Origin par Next.js ; SameSite=Lax | Next.js | — |
| XSS | Rendu React échappé, aucun `dangerouslySetInnerHTML` ; en-têtes `nosniff`, `X-Frame-Options: DENY` | `next.config.ts` | — |
| Injection SQL | Requêtes paramétrées Drizzle exclusivement (y compris `sql\`\``) | partout | — |
| Accès inter-entreprises | Contexte construit depuis `memberships` ; permissions vérifiées dans chaque service | `services/companies.ts` | ✅ |
| Élévation de privilèges | Règles propriétaire ; matrice testée | `permissions.ts` | ✅ |
| Altération de l'historique | Triggers + chaîne de hachage | `audit.ts`, migration 0001 | ✅ |
| Fuite d'informations par les erreurs | Message générique + référence de corrélation ; détail dans le journal technique | `http/action-result.ts` | — |
| Rejeu d'opérations financières | Table `idempotency_keys` prévue | schéma | ⬜ (avec les paiements) |

## Reste à faire
- MFA TOTP (et codes de secours).
- Réinitialisation du mot de passe par e-mail (dépend d'un service d'envoi : SMTP ou API — **dépendance externe**).
- Content-Security-Policy stricte avec nonce.
- Row Level Security PostgreSQL.
- Limitation de débit générale (au-delà de la connexion) au niveau du reverse proxy.
- Chiffrement des sauvegardes (voir `docs/08-sauvegarde-restauration.md`).
- Revue de sécurité externe / test d'intrusion avant mise en production.
