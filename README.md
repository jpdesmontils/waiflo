# Waiflo Editor

Visual editor and runner for **Waiflo** (AI Workflow Language) `.waiflo.json` pipelines.

## Features

- **Multi-user** — each user has their own isolated workspace (`waiflo-data/workflows/<userId>/`)
- **Visual DAG** — Cytoscape.js + dagre layout, step cards with inline expand
- **Step editor** — edit all fields inline (name, type, LLM config, system prompt, template, inputs/outputs schema)
- **Step runner** — execute steps directly from the UI with real-time SSE streaming
- **API key management** — each user provides their own Anthropic key (encrypted AES-256), or use a shared managed key
- **Self-hostable** — one `docker compose up`, zero external services required

---

## Quick start (Docker)

```bash
git clone https://github.com/you/waiflo
cd waiflo
cp .env.example .env
```

Edit `.env`:
```bash
JWT_SECRET=<generate: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">
MASTER_SECRET=<generate same way>
ANTHROPIC_API_KEY=    # optional — for managed plan
```

```bash
docker compose up -d
```

Open **http://localhost:3000**, create an account, add your Anthropic key in ⚙ Settings.

---

## Bare metal (VPS)

### Prerequisites

```bash
# Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs

# PM2
npm install -g pm2

# Nginx
sudo apt install -y nginx

# Certbot (Let's Encrypt)
sudo apt install -y certbot python3-certbot-nginx
```

### Deploy

```bash
git clone https://github.com/you/waiflo /var/www/waiflo
cd /var/www/waiflo
cp .env.example .env
nano .env   # fill in secrets

npm install --production

# Start with PM2
pm2 start server/index.js --name waiflo-editor
pm2 save
pm2 startup   # follow the printed command to enable on boot
```

### Nginx

```bash
sudo cp nginx.conf /etc/nginx/sites-available/waiflo
sudo ln -s /etc/nginx/sites-available/waiflo /etc/nginx/sites-enabled/

# Edit the server_name in the file
sudo nano /etc/nginx/sites-available/waiflo

sudo nginx -t && sudo systemctl reload nginx

# HTTPS
sudo certbot --nginx -d your-domain.com
```

### GitHub Actions CI/CD

Add these secrets to your GitHub repo (Settings → Secrets → Actions):

| Secret | Value |
|--------|-------|
| `VPS_HOST` | Your server IP or hostname |
| `VPS_USER` | SSH user (e.g. `ubuntu`) |
| `VPS_SSH_KEY` | Private SSH key (full content of `~/.ssh/id_rsa`) |
| `VPS_PATH` | Absolute path on VPS, e.g. `/var/www/waiflo` |

Every push to `main` will deploy automatically.

---

## Data layout

```
waiflo-data/
├── users.json                        ← user registry (hashed passwords, encrypted API keys)
└── workflows/
    ├── <userId>/
    │   ├── my_pipeline.waiflo.json
    │   └── other_workflow.waiflo.json
    └── <userId2>/
        └── ...
```

**Backup** = `rsync -av waiflo-data/ backup/`  
**Restore** = copy the folder back and restart.

---

## API reference

All `/api/workflows/*` and `/api/exec/*` routes require `Authorization: Bearer <token>`.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login → JWT |
| GET  | `/api/auth/me` | Current user info |
| PUT  | `/api/auth/apikey` | Save encrypted API key |
| GET  | `/api/workflows` | List user's workflows |
| GET  | `/api/workflows/:name` | Read workflow JSON |
| POST | `/api/workflows/:name` | Create workflow |
| PUT  | `/api/workflows/:name` | Save workflow |
| DELETE | `/api/workflows/:name` | Delete workflow |
| GET  | `/api/workflows/:name/export` | Download raw JSON |
| POST | `/api/exec/step` | Execute a step (SSE streaming for prompt, JSON for api) |

---

## Step schema (simplified)

```json
{
  "ws_name": "my_step",
  "ws_type": "prompt",
  "ws_inputs_schema": {
    "type": "object",
    "required": ["my_input"],
    "properties": {
      "my_input": { "type": "string" }
    }
  },
  "ws_llm": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "temperature": 0
  },
  "ws_system_prompt": "You are an expert…",
  "ws_prompt_template": "Analyse: {{{my_input}}}\nReturn: {{ws_output_schema}}",
  "ws_output_schema": {
    "type": "object",
    "properties": {
      "result": { "type": "string" }
    }
  }
}
```

`{{ws_output_schema}}` is a runtime variable — automatically replaced with the serialized output schema.  
`{{{triple_braces}}}` = raw injection (no HTML escaping).

---

## License

MIT
