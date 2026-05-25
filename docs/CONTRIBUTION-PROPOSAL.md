# Proposal: contributing ADO Installer to AgentRoot

> Paste-ready cover note for opening a PR, proposal issue, or Discussion on the
> AgentRoot repository. Edit the framing to match how AgentRoot prefers to take
> contributions (subdirectory PR vs. adopting the standalone repo).

---

## Proposal: ADO Installer — a domain-onboarding tool for AgentRoot (MIT)

**Repo:** https://github.com/fredo67/ado-installer · **License:** MIT

### What it is
A small, self-contained web app that takes a domain owner from *"I have a
domain"* to *"my domain is discoverable on AgentRoot"* in three steps —
**detect → authorize → verify** — modeled on Google Workspace's domain
activation flow. Offered to AgentRoot under MIT as a reference implementation of
domain onboarding; happy to re-home it under the org.

### What it does
It publishes the two AgentRoot `TXT` records for a domain:

```
_agent.{domain}  TXT  "v=agentroot1; card=https://{manifest-host}/{domain}/agent-card.json"
_skill.{domain}  TXT  "v=agentroot1; index=https://{manifest-host}/{domain}/skills/index.json"
```

- **Detect** the DNS host (live `dns.NS`) and registrar of record (system
  `whois` + RDAP fallback for newer gTLDs).
- **Authorize** the write — automated via the registrar API where one exists,
  guided copy/paste otherwise.
- **Verify** both records resolve, polling until propagation completes.

### Registrar support
| Registrar | Writes |
|---|---|
| Cloudflare | Automated — popup to CF's token creator (`Zone:DNS:Edit` pre-filled), token pasted back, used once via API |
| Porkbun | Automated — account API key + secret via REST |
| GoDaddy, Namecheap, Squarespace, Route 53, others | Guided copy/paste + deep link |

Adding a registrar is a contained, declarative change (see `CONTRIBUTING.md`).

### Footprint
- Backend: one `server.js` (Express). Frontend: one `public/index.html`,
  vanilla ES modules, **no build step**. SQLite logs install events only.
- Deps: express, better-sqlite3, dotenv, node-fetch. No proprietary services.

### Security model (please scrutinize)
- Registrar credentials are **request-scoped**: used once for the write, then
  dropped. Never written to disk, DB, or logs.
- The Cloudflare popup runs on `dash.cloudflare.com` — password/2FA never touch
  the app; it only receives the API token the user pastes back.
- Optional 30-min `sessionStorage` token reuse, client-side only, cleared on
  tab close or auth failure.
- Repo is clean of secrets/PII (audited; single-commit history).

### Docs
- `docs/AGENTROOT-RECORDS.md` — the TXT + manifest contract. **This is the file
  to reconcile against AgentRoot's canonical spec** — the implementation keys on
  `v=agentroot1` and a configurable `MANIFEST_BASE`, both trivial to align.
- `docs/ARCHITECTURE.md` — flow, detection, the activate-modal state machine.
- `CONTRIBUTING.md` — setup, conventions, adding a registrar, testing.

### To adopt
1. Confirm/align the record + manifest format in `docs/AGENTROOT-RECORDS.md`.
2. Set `MANIFEST_BASE` and the deploy hostnames for AgentRoot's environment.
3. Re-home under the `agentroot/` org (a remote rename).

### Status
Runs in production behind nginx/systemd. `DEMO=true` lets you click through the
whole flow offline. Open to feedback on the record format, the security model,
and which registrar integration to add next.
