# Sécurité

| Menace | Mesure | Où | Testé |
|---|---|---|---|
| Vol de base → mots de passe | scrypt N=2^17, r=8, p=1, sel 16 octets ; rehash automatique si paramètres renforcés | `security/password.ts` | ✅ |
| Vol de base → sessions | Seule l'empreinte SHA-256 du jeton est stockée | `services/auth.ts` | ✅ |
| Force brute | 5 échecs / 15 min par e-mail, 30 par IP ; message générique ; temps de réponse homogène (hash factice) | `services/auth.ts` | ✅ |
| Vol ou réutilisation du mot de passe | Double authentification TOTP (RFC 6238, 6 chiffres, 30 s, tolérance ±1 pas) : défi de 5 min en cookie HttpOnly SameSite=Strict, 5 essais au plus, échecs comptés dans la limitation des connexions ; code non rejouable (dernier pas mémorisé) ; 10 codes de secours à usage unique stockés hachés ; activation confirmée par un code, autres sessions fermées ; désactivation par mot de passe + code ; réinitialisation `npm run user:reset-mfa` | `services/mfa.ts`, `security/totp.ts` | ✅ `mfa.test.ts`, `totp.test.ts` (vecteurs RFC 6238) |
| Vol de base → secrets TOTP | Chiffrement AES-256-GCM, clé `APP_ENCRYPTION_KEY` hors base (obligatoire en production) | `security/encryption.ts` | ✅ |
| Énumération de comptes à la connexion | Message d'erreur identique | idem | ✅ |
| Mot de passe dans l'URL (envoi d'un formulaire avant chargement du JavaScript) | Formulaires à mot de passe en amélioration progressive (Server Action en `action`, POST natif) ; `method="post"` imposé à tous les autres | `app/actions/auth.ts`, formulaires | ✅ `forms-guard.test.ts` (faille constatée et corrigée le 20/10/2026) |
| Perte d'accès à un compte | Réinitialisation par l'administrateur technique (`npm run user:reset-password`) | `adminResetPassword` | ✅ |
| Vol de cookie | HttpOnly, SameSite=Lax, Secure + préfixe `__Host-` en production | `http/session.ts` | — |
| Session persistante après changement de mot de passe | Révocation de toutes les sessions | `changePassword` | ✅ |
| CSRF | Server Actions : contrôle de l'en-tête Origin par Next.js ; SameSite=Lax | Next.js | — |
| XSS | Rendu React échappé ; un seul `dangerouslySetInnerHTML` : QR code SVG produit par le serveur (bibliothèque `uqr`, sans texte utilisateur) ; en-têtes `nosniff`, `X-Frame-Options: DENY` | `next.config.ts` | — |
| Injection SQL | Requêtes paramétrées Drizzle exclusivement (y compris `sql\`\``) | partout | — |
| Accès inter-entreprises | Contexte construit depuis `memberships` ; permissions vérifiées dans chaque service | `services/companies.ts` | ✅ |
| Élévation de privilèges | Règles propriétaire ; matrice testée | `permissions.ts` | ✅ |
| Altération de l'historique | Triggers + chaîne de hachage | `audit.ts`, migration 0001 | ✅ |
| Fuite d'informations par les erreurs | Message générique + référence de corrélation ; détail dans le journal technique | `http/action-result.ts` | — |
| Rejeu d'opérations financières | Clés d'idempotence (règlements, tickets, remboursements, saisies OD) | `idempotency_keys`, `sourceKey` | ✅ |

## Reste à faire
- Rendre la double authentification obligatoire par rôle ou par entreprise (paramètre), et la signaler dans la liste des membres.
- Conserver la clé `APP_ENCRYPTION_KEY` : sa perte oblige à réinitialiser la double authentification de chaque utilisateur.
- Réinitialisation du mot de passe par e-mail (dépend d'un service d'envoi : SMTP ou API — **dépendance externe**).
- Content-Security-Policy stricte avec nonce.
- Row Level Security PostgreSQL.
- Limitation de débit générale (au-delà de la connexion) au niveau du reverse proxy.
- Chiffrement des sauvegardes (voir `docs/08-sauvegarde-restauration.md`).
- Revue de sécurité externe / test d'intrusion avant mise en production.
