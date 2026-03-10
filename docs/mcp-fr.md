# MCP dans Waiflo — logique, paramétrage et utilisation

Ce document récapitule **comment Waiflo gère les serveurs MCP**, comment configurer la registry, et comment créer des étapes opérationnelles qui appellent des tools (Mapbox / Google Maps).

## 1) Logique de gestion MCP

Dans Waiflo, la chaîne MCP fonctionne en 4 couches :

1. **Registry (`MCPRegistry`)**
   - Charge la config `mcp_servers` (depuis JSON inline, fichier, ou settings user).
   - Normalise les champs (`transport`, `url`, `headers`, `retry`, `timeoutMs`, `allowedTools`, etc.).
   - Résout l'auth dynamique via `auth.tokenEnvVar` + variables d'environnement.

2. **Client (`MCPClient`)**
   - Ouvre la connexion vers le serveur MCP (`http`, `stdio`, `websocket`).
   - Exécute les méthodes MCP JSON-RPC (`tools/list`, `tools/call`).
   - Gère timeout + retry/backoff.

3. **Runtime (`MCPToolRuntime`)**
   - Fait la découverte des tools (`discoverTools`) et met en cache.
   - Applique le filtrage `allowedTools`.
   - Valide les inputs requis, exécute le tool et normalise la sortie.

4. **Runner de step (`runMcpStep`)**
   - Lit `step.ws_mcp.server` et `step.ws_mcp.tool`.
   - Rend le template de `step.ws_mcp.input` avec les inputs du pipeline.
   - Appelle l'executor MCP et remonte le résultat au step suivant.

## 2) Où configurer la registry

Tu as 2 modes principaux :

- **Par utilisateur (recommandé en multi-user)**
  - Via l'UI: `Settings > Configuration MCP`.
  - API: `PUT /api/mcp/config`.
  - Secrets via `PUT /api/mcp/apikey`.

- **Global serveur (fallback)**
  - `MCP_SERVERS_JSON` (env inline), ou
  - `MCP_SERVERS_FILE` (fichier, défaut: `./mcp_servers.json`).

Les placeholders `${...}` dans la registry sont résolus avec les secrets user puis `process.env`.

---

## 3) Exemples JSON de registry

### 3.1 Registry minimal HTTP (Google + Mapbox)

```json
{
  "mcp_servers": {
    "google_maps": {
      "transport": "http",
      "url": "https://your-google-mcp-host.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${GOOGLE_MAPS_API_KEY}"
      },
      "timeoutMs": 30000,
      "retry": {
        "retries": 1,
        "backoffMs": 300
      }
    },
    "mapbox": {
      "transport": "http",
      "url": "https://your-mapbox-mcp-host.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MAPBOX_API_KEY}"
      },
      "timeoutMs": 30000,
      "retry": {
        "retries": 1,
        "backoffMs": 300
      }
    }
  }
}
```

### 3.2 Registry avec restriction de tools (`allowedTools`)

```json
{
  "mcp_servers": {
    "google_maps": {
      "transport": "http",
      "url": "https://your-google-mcp-host.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${GOOGLE_MAPS_API_KEY}"
      },
      "allowedTools": ["places_search", "geocode"]
    },
    "mapbox": {
      "transport": "http",
      "url": "https://your-mapbox-mcp-host.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MAPBOX_API_KEY}"
      },
      "allowedTools": ["geocoding_forward", "directions"]
    }
  }
}
```

---

## 4) Exemples d'étapes opérationnelles (Waiflo)

### 4.1 Step qui appelle Mapbox

```json
{
  "ws_name": "lookup_address_mapbox",
  "ws_type": "mcp",
  "ws_inputs_schema": {
    "type": "object",
    "required": ["query"],
    "properties": {
      "query": { "type": "string" }
    }
  },
  "ws_mcp": {
    "adapter": "mapbox",
    "server": "mapbox",
    "tool": "geocoding_forward",
    "input": {
      "query": "{{query}}",
      "limit": 5,
      "language": "fr"
    }
  },
  "ws_output_schema": {
    "type": "object",
    "properties": {
      "features": { "type": "array" }
    }
  }
}
```

### 4.2 Step qui appelle Google Maps

```json
{
  "ws_name": "search_places_google",
  "ws_type": "mcp",
  "ws_inputs_schema": {
    "type": "object",
    "required": ["textQuery"],
    "properties": {
      "textQuery": { "type": "string" }
    }
  },
  "ws_mcp": {
    "adapter": "google_maps",
    "server": "google_maps",
    "tool": "places_search",
    "input": {
      "textQuery": "{{textQuery}}",
      "languageCode": "fr"
    }
  },
  "ws_output_schema": {
    "type": "object",
    "properties": {
      "places": { "type": "array" }
    }
  }
}
```

> Important: les noms de `tool` doivent correspondre aux tools réellement exposés par ton serveur MCP. Utilise la découverte (`/api/mcp/tools?server=...`) pour confirmer les noms exacts.
