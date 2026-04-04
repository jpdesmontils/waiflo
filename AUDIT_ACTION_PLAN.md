# Audit complet (code mort, duplication, robustesse, bugs, sécurité)

Date: 2026-04-04

## Résumé exécutif

Le projet est globalement fonctionnel, mais il contient des risques **élevés** côté sécurité front/back (XSS et exposition de secrets), des fragilités de concurrence sur l’écriture du store utilisateur, et une base front-end encore très couplée (`public/app.js` centralise beaucoup de responsabilités).

---

## 1) Sécurité — constats prioritaires

### S1 — Risque XSS via `innerHTML` avec données dynamiques
- `renderWorkflowList()` injecte `wf.name` directement dans `innerHTML` et dans des handlers inline (`onclick="...('${wf.name}',event)"`).  
  Référence: `public/app.js` lignes 458-467.
- `renderMcpServerRows()` injecte des champs serveurs MCP (`server_label`, `server_url`, `last_error`, `tools`) dans `innerHTML` sans escaping.  
  Référence: `public/app.js` lignes 1768-1783.
- `openModal()` assigne du HTML arbitraire via `modal-body.innerHTML = bodyHtml`.  
  Référence: `public/app.js` ligne 1917.

**Impact:** exécution de script côté client si une valeur malveillante est persistée (workflow name, erreur serveur, labels MCP).

**Action recommandée (P0):**
1. Remplacer les chaînes HTML dynamiques par création DOM (`createElement`, `textContent`) pour toutes les zones ci-dessus.
2. Supprimer les handlers inline `onclick="..."` et basculer en listeners.
3. Introduire une fonction d’escaping HTML unique (ou utilitaire DOM-only) et bannir `innerHTML` pour les données utilisateur.

---

### S2 — Exposition de secrets MCP au navigateur
- Le backend déchiffre `apiKeyEnc` et renvoie la clé en clair vers le front (`api_key`).  
  Référence: `server/routes/auth.js` lignes 121-131.
- Cette structure est renvoyée par `/api/auth/me` (champ `mcpServers`).  
  Référence: `server/routes/auth.js` lignes 268-274.
- Le front réinsère ces clés dans des champs formulaire (`value="${srv.api_key}"`).  
  Référence: `public/app.js` ligne 1772.

**Impact:** compromission des secrets en cas XSS / extension navigateur / fuite session.

**Action recommandée (P0):**
1. Ne jamais renvoyer `api_key` en clair depuis `/api/auth/me`.
2. Remplacer par `has_api_key: boolean` + mécanisme “remplacer la clé” côté UI.
3. Nettoyer toute trace de clé dans le front state après sauvegarde.

---

### S3 — Token JWT stocké en `localStorage`
- Le token est lu/écrit en `localStorage` (`wf_token`).  
  Référence: `public/app.js` ligne 20.

**Impact:** si XSS, exfiltration immédiate de session.

**Action recommandée (P1):**
1. Migrer vers cookie `HttpOnly` + `Secure` + `SameSite`.
2. Ajouter stratégie de rotation/token court + refresh.

---

### S4 — CORS permissif par défaut
- Si `CORS_ORIGIN` absent, CORS autorise tout (`true`).  
  Référence: `server/index.js` lignes 52-55.

**Impact:** surface d’attaque élargie en configuration par défaut.

**Action recommandée (P1):**
1. En production, imposer `CORS_ORIGIN` non vide (fail-fast).
2. Journaliser explicitement l’origine active au démarrage.

---

### S5 — Chiffrement sans authentification
- Crypto applicative en `aes-256-cbc` + clé dérivée via sel statique (`waiflo-salt`).  
  Référence: `server/lib/crypto.js` lignes 5-10, 13-29.

**Impact:** intégrité non garantie (CBC sans MAC), design perfectible pour stockage de secrets.

**Action recommandée (P1):**
1. Migrer vers `aes-256-gcm` (IV + tag) ou libsodium sealed box.
2. Ajouter versionnement de format pour migration progressive des secrets.

---

## 2) Robustesse / bugs potentiels

### R1 — Risque de lost update sur le store users JSON
- `saveUser()` fait read-modify-write sans verrou transactionnel.  
  Référence: `server/lib/users.js` lignes 33-37.

**Impact:** écrasement silencieux en cas d’écritures concurrentes.

**Action recommandée (P1):**
1. Implémenter verrou fichier/mutex process-safe.
2. Écriture atomique via fichier temporaire + rename.
3. À moyen terme: migrer vers SQLite/PostgreSQL.

---

### R2 — Couplage front fort et dette de maintenabilité
- `public/app.js` reste très volumineux et concentre UI graph + édition + exécution + settings.

**Impact:** régressions plus probables, tests difficiles.

**Action recommandée (P2):**
1. Modulariser par domaine (`graph`, `editor`, `run`, `settings`, `ui/modal-toast`).
2. Introduire un store état minimal (module dédié) + fonctions pures testables.

---

## 3) Code mort / duplication

### D1 — Code mort probable
- `runPromptStep_legacy` exporté mais non utilisé dans le code serveur actuel.  
  Référence: `server/lib/runner.js` lignes 197+.

**Action recommandée (P2):**
1. Supprimer la version legacy si non référencée.
2. Ou la garder derrière un flag avec test de non-régression explicite.

---

### D2 — Duplication de pattern UI via templates HTML concaténés
- Plusieurs segments `innerHTML` recréent des patterns répétitifs (listes workflows, MCP, modales).

**Action recommandée (P2):**
1. Introduire helpers de rendu DOM (`el(tag, attrs, children)`).
2. Centraliser les composants répétitifs (row workflow, row MCP, modal actions).

---

## 4) Plan d’actions proposé (ordre recommandé)

## Sprint 0 (immédiat — sécurité critique)
1. **P0**: supprimer retour `api_key` dans `/api/auth/me` et adapter UI (masquage/remplacement clé).  
2. **P0**: éliminer injections `innerHTML` sur données non sûres + suppression handlers inline.
3. **P0**: ajouter tests d’intégration sécurité minimaux (payload XSS dans `wf.name`, `last_error`).

## Sprint 1 (sécurité/fiabilité)
1. **P1**: migration session `localStorage` → cookie `HttpOnly`.
2. **P1**: CORS strict en prod (fail startup si absent).
3. **P1**: migration crypto vers AEAD (`aes-256-gcm`) + rétrocompat lecture ancienne version.
4. **P1**: verrou/écriture atomique `users.json`.

## Sprint 2 (qualité / dette technique)
1. **P2**: découpage complet `public/app.js` en modules métier.
2. **P2**: suppression code legacy non utilisé (`runPromptStep_legacy`) après validation.
3. **P2**: ajouter lint + tests unitaires (helpers JSON/schema/render).

---

## KPI de suivi
- 0 secret exposé dans payload `/api/auth/me`.
- 0 usage `innerHTML` avec données utilisateur non échappées.
- 100% des écritures utilisateur via chemin atomique.
- Couverture tests sur modules critiques: auth, exécution workflow, rendu dynamique.
