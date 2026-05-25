# ADO Installer

> One‑click onboarding for [AgentRoot](https://www.agentroot.io). Point a domain at AgentRoot
> by writing two DNS `TXT` records — automatically where we can, guided where we can't.

**License:** [MIT](#license) · No build step, single backend file. (Self-host — see [Deployment](#deployment).)

ADO ("AgentRoot Domain Onboarding") Installer is a small, self‑contained web app that takes a
domain owner from *"I have a domain"* to *"my domain is discoverable on AgentRoot"* in three
steps — **detect → authorize → verify** — modeled on the Google Workspace domain‑activation
flow. It's intentionally tiny: one Express file, one HTML file, no front‑end framework, no
build pipeline.

This repository is offered to the AgentRoot project as a reference implementation of a domain
onboarding tool, under the MIT license. See [Contributing to AgentRoot](#contributing-to-agentroot).

---

## What it does

A domain joins AgentRoot by publishing two DNS `TXT` records that point at a manifest host:

```
_agent.{domain}  TXT  "v=agentroot1; card=https://{manifest-host}/{domain}/agent-card.json"
_skill.{domain}  TXT  "v=agentroot1; index=https://{manifest-host}/{domain}/skills/index.json"
```

The installer:

1. **Detects** which DNS host and registrar a domain uses (live `dns.NS` lookup for the DNS
   operator, system `whois` + RDAP fallback for the registrar of record).
2. **Authorizes** the write — automatically through the registrar's API where one exists, or
   by guiding the user to paste the records into their DNS panel.
3. **Verifies** that both records resolve, polling until propagation completes.

The exact record format and manifest JSON shapes are documented in
[`docs/AGENTROOT-RECORDS.md`](docs/AGENTROOT-RECORDS.md) — that's the file the AgentRoot team
will most want to reconcile against the canonical spec.

## Registrar support

| Registrar | Detection | Record writes |
|---|---|---|
| **Cloudflare** | NS `*.ns.cloudflare.com` | **Automated** — popup to Cloudflare's token creator (`Zone:DNS:Edit` pre‑filled), token pasted back, used once via the Cloudflare API |
| **Porkbun** | NS `*.porkbun.com` | **Automated** — account API key + secret via the Porkbun REST API |
| GoDaddy, Namecheap, Squarespace, AWS Route 53 | NS match | **Manual** — copy/paste the two records, with a deep link to the DNS page |
| Anything else / parked | NS unknown | **Manual** — generic copy/paste flow |

Automated registrars are driven by a small declarative table (`AUTOMATED` in
`public/index.html`, registrar endpoints in `server.js`); adding a new one is a contained
change — see [`CONTRIBUTING.md`](CONTRIBUTING.md#adding-a-registrar).

## Security model

Credentials are **never stored and never logged.** A Cloudflare token or Porkbun key/secret is
read from a single request, used for the API call that writes the records, and then falls out
of scope. For the Cloudflare popup flow, the password and 2FA stay on `cloudflare.com` — the
app only ever sees the resulting API token the user pastes back.

- The Cloudflare popup opens `dash.cloudflare.com` directly; we never proxy Cloudflare login.
- A successful Cloudflare token may be cached in the browser's `sessionStorage` for 30 minutes
  (cleared on tab close) so a bulk install of many domains doesn't re‑prompt. A `forget` link
  clears it; a token that fails server‑side is discarded automatically.
- SQLite stores **install events only** (`domain, registrar, status, timestamps`) — no secrets.

## Architecture

```
Browser (public/index.html, vanilla ES modules)
   │  POST /api/detect      → NS lookup + whois/RDAP registrar
   │  POST /api/cloudflare/install  (token)        ┐ write _agent + _skill TXT,
   │  POST /api/porkbun/install     (apikey/secret)┘ generate stub manifests
   │  POST /api/verify      → resolve both TXT records
   ▼
server.js (Express)  ──>  manifests/{domain}/agent-card.json, skills/index.json  (served at /manifests)
                     ──>  data.db (SQLite: install log)
```

Full design notes — the activate‑modal state machine, detection logic, manifest hosting,
and `DEMO` mode — are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## API

| Method | Route | Body | Returns |
|---|---|---|---|
| `GET`  | `/` | — | the SPA |
| `POST` | `/api/detect` | `{domain, whois?}` | `{registrar, registrar_slug, deep_link, automated, ns, whois_registrar, registrar_source}` |
| `POST` | `/api/cloudflare/install` | `{domain, token}` | `{success, record_ids}` — token used once, discarded |
| `POST` | `/api/porkbun/install` | `{domain, apikey, secretapikey}` | `{success, record_ids}` — keys used once, discarded |
| `POST` | `/api/verify` | `{domain}` | `{agent:{ok,value}, skill:{ok,value}}` |
| `GET`  | `/manifests/{domain}/...` | — | the generated stub manifests (CORS‑open JSON) |

## Quick start

Requires **Node ≥ 18** (uses global `fetch`; `whois` optional for registrar lookup).

```bash
git clone https://github.com/fredo67/ado-installer.git
cd ado-installer
npm install                 # builds the better-sqlite3 native module
cp .env.example .env        # DEMO=true by default
npm run dev                 # http://127.0.0.1:4180
```

### Demo mode

With `DEMO=true` (the default), no external calls are made so you can click through the whole
flow offline:

- `/api/detect` still does a **real** NS + registrar lookup (detection is read‑only and safe)
- `/api/cloudflare/install` and `/api/porkbun/install` report success without calling the registrar
- `/api/verify` succeeds 8 seconds after install

Set `DEMO=false` for live registrar writes and real propagation checks.

### Configuration (`.env`)

| Var | Default | Purpose |
|---|---|---|
| `DEMO` | `true` | Mock registrar writes + verify (detection stays real) |
| `PORT` | `4180` | Port the server listens on |
| `MANIFEST_BASE` | `https://manifests.example.com` | Public base URL embedded in the TXT records and served from `/manifests`. **Set this to your own manifest host.** |

## Project layout

```
ado-installer/
├── server.js              # Express app: detect, install (CF/Porkbun), verify, manifest hosting
├── public/index.html      # entire SPA — inline CSS + vanilla ES modules, no build step
├── schema.sql             # SQLite: single `installs` table (install log only)
├── .env.example           # configuration template
├── deploy/                # reference systemd unit + nginx vhost (adjust hostnames)
├── docs/
│   ├── ARCHITECTURE.md     # request flow, state machine, detection, DEMO mode
│   └── AGENTROOT-RECORDS.md# the TXT record + manifest format this writes
├── CONTRIBUTING.md
└── LICENSE                 # MIT
```

`data.db` and `manifests/` are generated at runtime and git‑ignored.

## Deployment

The app is a single long‑running Node process behind nginx. The reference deployment uses
systemd + nginx + certbot; the unit and vhost templates live in [`deploy/`](deploy/).

```bash
# 1. Point two A records at your server:
#      installer.example.com   A   <server-ip>
#      manifests.example.com   A   <server-ip>

# 2. Copy the app and install production deps
rsync -avz --delete --exclude node_modules --exclude 'data.db*' \
  --exclude manifests --exclude .env ./ user@<server-ip>:/opt/ado-installer/
ssh user@<server-ip> 'cd /opt/ado-installer && npm install --omit=dev && cp -n .env.example .env'
# edit /opt/ado-installer/.env: set MANIFEST_BASE=https://manifests.example.com and DEMO=false

# 3. systemd  (adjust paths/user in deploy/ado-installer.service first)
sudo cp deploy/ado-installer.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ado-installer

# 4. nginx  (adjust server_name in deploy/nginx.conf first)
sudo cp deploy/nginx.conf /etc/nginx/sites-available/ado-installer.conf
sudo ln -sf /etc/nginx/sites-available/ado-installer.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 5. TLS
sudo certbot --nginx -d installer.example.com -d manifests.example.com \
  --non-interactive --agree-tos -m you@example.com --redirect
```

`manifests.example.com` is proxied to the same backend so the `/manifests/{domain}/...` URLs in
the TXT records resolve over HTTPS.

## Contributing

Bug reports, registrar integrations, and UX improvements are welcome. Start with
[`CONTRIBUTING.md`](CONTRIBUTING.md) — it covers local setup, the (deliberately small) tech
conventions, how to add a registrar, and how the headless‑Chrome screenshot checks work.

### Contributing to AgentRoot

This project is MIT‑licensed (see [`LICENSE`](LICENSE)) specifically so it can be folded into
the AgentRoot ecosystem. To adopt it:

- The record/manifest format in [`docs/AGENTROOT-RECORDS.md`](docs/AGENTROOT-RECORDS.md) should
  be reconciled with AgentRoot's canonical spec; the implementation reads `v=agentroot1` and a
  `manifests.{host}` base, both easy to align.
- There are no proprietary dependencies — Express, better‑sqlite3, dotenv, node‑fetch — and no
  secrets in the repo.
- Re‑homing under an `agentroot/` org is a remote rename; `MANIFEST_BASE` and the deploy
  hostnames are the only environment‑specific values.

## License

[MIT](LICENSE) © 2026 Fred Hsu. Contributions are accepted under the same license.
