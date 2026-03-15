# Analyse globale du code — Waiflo

> Date: 2026-03-13
> Portée: revue statique du dépôt (`server/`, `public/`, templates, config) + inspection des flux d’auth, d’édition de workflow, et d’exécution.

## Résumé exécutif

Le code est globalement lisible et modulaire (routes séparées, librairies dédiées, providers LLM bien isolés), mais il reste **3 risques majeurs** à traiter en priorité:

1. **Risque de corruption de données utilisateur (concurrence d’écriture)** dans `users.json` via pattern read-modify-write sans verrouillage.  
2. **Écritures de workflows non atomiques / validation tardive**, qui peuvent persister des JSON invalides avant de répondre en erreur.  
3. **Surface d’attaque réseau SSRF élevée** sur les steps `api` / `webpage` (URL libre côté utilisateur, sans allowlist ni filtrage d’IP privée).

---

## 1) Bugs majeurs identifiés

## B1 — Concurrence: pertes de mises à jour dans `users.json` (**Majeur**)

**Pourquoi c’est grave**  
`saveUser()` charge tout le fichier, fusionne en mémoire, puis réécrit le fichier complet. Deux requêtes simultanées peuvent écraser mutuellement leurs changements (ex: update clé API + update mot de passe).  

**Preuve code**
- Lecture intégrale: `readUsers()`.
- Écriture intégrale: `writeUsers()`.
- Pattern read-modify-write: `saveUser()`.

**Impact**  
Perte silencieuse de données utilisateur, état incohérent, bugs intermittents difficiles à reproduire.

**Correction recommandée**  
- Introduire un verrou (file lock robuste) ou migration vers SQLite/Postgres.
- Éviter la réécriture du document complet pour de petites mutations concurrentes.

---

## B2 — Workflow potentiellement sauvegardé invalide avant échec API (**Majeur**)

**Pourquoi c’est grave**  
Dans `POST /api/workflows/:name` et `PUT /api/workflows/:name`, si `req.body` est une string invalide JSON:
1) Le contenu est écrit sur disque.
2) Ensuite seulement, `JSON.parse()` est tenté pour extraire des métadonnées.
3) En cas d’erreur, API répond 500 mais le fichier invalide est déjà persisté.

**Impact**  
Corruption de workflow, erreurs ultérieures au chargement (`GET /:name` renvoie 400 « invalid JSON »), mauvaise UX.

**Correction recommandée**
- Valider/parsing **avant** `fs.writeFile`.
- Écrire de manière atomique (fichier temp + rename) pour éviter les demi-états.

---

## B3 — SSRF sur steps `api` / `webpage` (**Majeur sécurité**)

**Pourquoi c’est grave**  
`runApiStep()` et `runWebpage*Step()` exécutent des `fetch()` vers des URLs définies par les workflows. Sans filtrage, un utilisateur authentifié peut viser des ressources internes (ex: `http://127.0.0.1`, metadata cloud, services privés du VPC).

**Impact**  
Exfiltration d’informations internes, pivot réseau, accès à endpoints d’administration non exposés publiquement.

**Correction recommandée**
- Allowlist stricte des domaines.
- Blocage IP privées/loopback/link-local + DNS rebinding hardening.
- Option « outbound proxy contrôlé ».

---

## 2) Autres bugs/importants (niveau élevé mais non bloquant immédiat)

- **Validation JSON incomplète dans Design API**: `readWf()` parse directement sans retour métier dédié; JSON corrompu donne 500 plutôt qu’un 400 explicite.  
- **Normalisation email absente**: comparaison d’email brute (`userExists`, `findByEmail`) → risque de doublons logiques (`User@x.com` vs `user@x.com`).  
- **Logs MCP: user id incorrect** dans `/mcp-validate` (`req.user.id` au lieu de `req.user.userId`), rendant le diagnostic moins fiable.

---

## 3) Code mort (dead code) identifié

## D1 — Module complet non référencé: `server/lib/autoToolRouter.js`

Aucun import applicatif détecté de ce module dans `server/` et `public/`. Les exports suivants semblent inutilisés en production:
- `buildToolIndex`
- `resolveAutoTool`
- `buildToolArgumentsFromPrompt`

**Action**: supprimer ou intégrer explicitement dans le pipeline d’exécution tool.

## D2 — Export inutilisé: `listAllTools` dans `server/lib/mcpShared.js`

Export présent mais non consommé par les routes/lib actuelles.  
**Action**: supprimer l’export ou ajouter un endpoint qui l’utilise réellement.

---

## 4) Risques de maintenance / dette technique

- **Stockage fichier JSON pour users/runs/workflows**: simple mais fragile sous charge et concurrence.
- **Absence de tests automatiques** dans le repo: pas de garde-fous sur auth, workflows, runner.
- **Gestion d’erreurs inégale**: certaines routes renvoient 500 générique là où un 4xx explicite serait préférable.

---

## 5) Priorisation des corrections

## Sprint 1 (immédiat)
1. Corriger concurrence `users.json` (verrouillage ou DB).
2. Rendre l’écriture workflow atomique + validation avant persistance.
3. Ajouter protections SSRF (denylist IP privées + allowlist domaine).

## Sprint 2
4. Normaliser email (lowercase + trim) à l’inscription/login.
5. Harmoniser erreurs JSON corrompu (retours 400 cohérents).
6. Retirer code mort (`autoToolRouter`, `listAllTools`) ou le brancher réellement.

## Sprint 3
7. Ajouter tests minimaux critiques (auth/register/login, save/load workflow, run api/webpage/tool).
8. Introduire stockage transactionnel (SQLite) pour utilisateurs et runs.

---

## Commandes utilisées pour l’audit

- `rg --files -g 'AGENTS.md'`
- `find . -maxdepth 3 -type f | head -n 200`
- `cat package.json`
- `sed -n ...` / `nl -ba ...` sur les fichiers de `server/`, `public/`, `labels/`, `templates/`, `content/`
- `rg "lib/blog|..." -n ...`
- `for f in ...; do rg ...; done` (détection de références par module)

