# Audit du code — Waiflo Editor

> Réalisé le 2026-03-08

## Vue d'ensemble

Waiflo est une application Node.js/Express + React permettant d'éditer et d'exécuter des workflows LLM. L'architecture est claire et modulaire, mais plusieurs problèmes de sécurité, qualité et performance méritent attention avant une mise en production.

---

## 1. Architecture

```
waiflo/
├── server/
│   ├── index.js              # Point d'entrée Express
│   ├── lib/
│   │   ├── crypto.js         # Chiffrement AES-256
│   │   ├── users.js          # Persistance fichier (users.json)
│   │   └── runner.js         # Exécution des étapes LLM
│   └── routes/
│       ├── auth.js           # Inscription, login, JWT, clés API
│       ├── workflows.js      # CRUD des fichiers .waiflo.json
│       ├── exec.js           # Exécution SSE (streaming)
│       └── design.js         # Édition granulaire des steps
├── public/
│   └── app.js                # UI React Flow
├── docker-compose.yml
├── nginx.conf
└── .env.example
```

**Dépendances npm :** `@anthropic-ai/sdk`, `bcryptjs`, `cors`, `dotenv`, `express`, `jsonwebtoken`, `uuid`

---

## 2. Problèmes de sécurité

### CRITIQUE

| # | Fichier | Ligne | Problème |
|---|---------|-------|---------|
| S1 | `server/routes/auth.js` | 9 | **Fallback JWT_SECRET hardcodé** : `process.env.JWT_SECRET \|\| 'change-me'`. Si la variable d'env est absente, les tokens peuvent être forgés par n'importe qui. |
| S2 | `server/routes/exec.js` | 14 | Même fallback `'change-me'` pour la vérification JWT. |

**Fix immédiat :**
```javascript
// server/index.js — ajouter au démarrage
if (!process.env.JWT_SECRET || !process.env.MASTER_SECRET) {
  console.error('ERREUR: JWT_SECRET et MASTER_SECRET doivent être définis');
  process.exit(1);
}
```

### MOYEN

| # | Fichier | Problème | Recommandation |
|---|---------|---------|----------------|
| S3 | `server/index.js:51` | `cors({ origin: true })` accepte toutes les origines → risque CSRF | Restreindre à `origin: ['https://votre-domaine.com']` |
| S4 | `server/lib/crypto.js:8` | Sel de chiffrement statique : `'waiflo-salt'` hardcodé dans le code | Utiliser un sel aléatoire par utilisateur |
| S5 | `server/routes/auth.js:35` | JWT expire dans 30 jours, aucune révocation possible | Réduire à 7j, ajouter refresh tokens |
| S6 | `server/lib/runner.js:4` | Clé API décryptée en clair en mémoire | Effacer la variable après usage : `apiKey = null` |
| S7 | Toutes routes | Aucun rate limiting → brute force login, abus d'exécution | Ajouter `express-rate-limit` |

### FAIBLE

| # | Problème | Recommandation |
|---|---------|----------------|
| S8 | Politique de mot de passe : minimum 8 caractères seulement | Augmenter à 12, ou utiliser zxcvbn |
| S9 | Version exposée dans `/api/health` | Supprimer le champ `version` |
| S10 | Stream SSE sans timeout côté serveur | Ajouter `AbortController` avec timeout 5min |

---

## 3. Qualité du code

### Code dupliqué

Les fonctions `safeName()` et `wfPath()` sont définies de manière identique dans deux fichiers :

- `server/routes/workflows.js:12-22`
- `server/routes/design.js:20-30`

**Fix :** Extraire dans `server/lib/utils.js`.

### Gestion d'erreurs silencieuse

Plusieurs blocs `catch` vides masquent des erreurs potentiellement réelles :

```javascript
// workflows.js:70 — masque permission denied, erreurs I/O disque
try { await fs.access(fp); } catch { /* ok */ }

// users.js:11 — ne distingue pas ENOENT des vraies erreurs
try { await fs.access(USERS_FILE); } catch { await fs.writeFile(...) }
```

**Fix :** Vérifier `err.code === 'ENOENT'` plutôt que d'ignorer toutes les erreurs.

### Crash non fatal

```javascript
// server/index.js:4
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  // Le serveur continue — état potentiellement corrompu
});
```

**Fix :** Ajouter `process.exit(1)` pour laisser Docker/PM2 relancer proprement.

### JSON corrompu non géré

```javascript
// server/routes/workflows.js:57
res.json(JSON.parse(raw)); // Crash si fichier corrompu
```

**Fix :** Entourer de `try/catch` avec réponse 400 claire.

---

## 4. Performance

| # | Problème | Impact | Fix |
|---|---------|--------|-----|
| P1 | `users.json` entièrement parsé à chaque opération | Lent avec > 1 000 utilisateurs | Cache mémoire avec TTL, ou migration SQLite |
| P2 | `findByEmail()` : recherche linéaire O(n) | Lent à l'authentification | Index email → userId en mémoire |
| P3 | `scryptSync()` bloque l'event loop | Latence visible sous charge | Utiliser `scrypt()` async |
| P4 | `fs.stat()` appelé séquentiellement par fichier workflow | Lent avec > 100 workflows | `fs.readdir()` avec `{ withFileTypes: true }` |

---

## 5. Tests

**Aucun fichier de test détecté.**

Fichiers critiques sans couverture :

| Fichier | Risques non testés |
|---------|-------------------|
| `server/lib/crypto.js` | Roundtrip encrypt/decrypt, tampering |
| `server/routes/auth.js` | Tokens forgés, mots de passe faibles, emails dupliqués |
| `server/routes/workflows.js` | Path traversal, fichiers corrompus, writes concurrents |
| `server/lib/runner.js` | Erreurs API Anthropic, timeouts SSE |

---

## 6. Documentation

**Points positifs :** README clair, quick start Docker, référence API, déploiement VPS documenté.

**Manquant :**
- `ARCHITECTURE.md` — flux de données, modèle de sécurité
- `SECURITY.md` — menaces connues et mitigations
- `DEVELOPMENT.md` — setup dev local, contribution, tests
- JSDoc sur les fonctions exportées de `server/lib/`

---

## Plan d'action recommandé

### Immédiat (avant production)
1. **Supprimer les fallbacks `'change-me'`** et valider les vars d'env au démarrage
2. **Restreindre CORS** à l'origine réelle de l'application
3. **Ajouter rate limiting** sur `/api/auth/*` et `/api/exec/*`
4. **Tester les path traversal** sur les noms de workflows

### Avant passage à l'échelle
5. Extraire `safeName()` / `wfPath()` dans `server/lib/utils.js`
6. Remplacer `scryptSync()` par `scrypt()` async
7. Ajouter un cache utilisateur en mémoire ou migrer vers SQLite
8. Écrire tests unitaires pour `server/lib/`

### Nice to have
9. Réduire JWT à 7j + refresh tokens
10. Heartbeat SSE + timeout explicite
11. Ajouter `SECURITY.md` et `ARCHITECTURE.md`
