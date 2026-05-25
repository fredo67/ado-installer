# AgentRoot records & manifests

This is the data contract the installer writes. **It should be reconciled with AgentRoot's
canonical specification** — the values below reflect what this reference implementation
produces today, and the two places they're defined are easy to align (`records()` and
`writeManifests()` in `server.js`, mirrored for display in `public/index.html`).

## DNS TXT records

Two records are written per domain:

```
_agent.{domain}  TXT  "v=agentroot1; card=https://{MANIFEST_BASE}/{domain}/agent-card.json"
_skill.{domain}  TXT  "v=agentroot1; index=https://{MANIFEST_BASE}/{domain}/skills/index.json"
```

- `v=agentroot1` — version tag; verification matches on the substring `v=agentroot1`.
- `card=` / `index=` — absolute HTTPS URLs to the manifests, under a configurable
  `MANIFEST_BASE` host (e.g. `https://manifests.example.com`).
- TTL: 120 s on Cloudflare, 600 s on Porkbun (registry minimum).

A domain is considered **live on AgentRoot** when both `_agent` and `_skill` TXT records
resolve and contain `v=agentroot1`.

## Manifest files

Generated as minimal stubs on install (and idempotently on verify), served at
`/manifests/{domain}/...` with `Access-Control-Allow-Origin: *`.

### `agent-card.json`

```json
{
  "name": "{domain}",
  "url": "https://{domain}",
  "version": "1.0.0",
  "skills": [],
  "verified_at": "{ISO-8601 timestamp}",
  "registry": "https://www.agentroot.io"
}
```

### `skills/index.json`

```json
{
  "version": "agentroot1",
  "domain": "{domain}",
  "skills": []
}
```

These are intentionally empty scaffolds — the installer's job is to make a domain *discoverable*
(records resolve, manifests exist). Populating skills/cards is a separate concern and a natural
extension point for AgentRoot to own.

## Points to align with the canonical spec

- Record names (`_agent`, `_skill`), the `v=agentroot1` tag, and the `card=`/`index=` keys.
- Manifest field names and required vs. optional fields (`verified_at`, `registry`, `version`).
- Whether the manifest host is fixed by AgentRoot or per‑deployment (here it's `MANIFEST_BASE`).
- Signing/verification expectations, if any, beyond "the TXT record resolves".
