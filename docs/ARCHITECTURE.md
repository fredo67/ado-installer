# Architecture

ADO Installer is two files plus a SQLite log. This document explains how they fit together.

## Components

| Piece | File | Role |
|---|---|---|
| Backend | `server.js` | Express app: detection, registrar installs, verify, manifest hosting, install log |
| Frontend | `public/index.html` | Single‑page app — inline CSS, one ES‑module `<script>`, no build |
| Schema | `schema.sql` | One table, `installs` (install events only) |
| Manifests | `manifests/{domain}/…` | Per‑domain stub JSON, generated on install, served at `/manifests` |

## Request flow

```
1. detect    POST /api/detect  {domain}
                ├─ dns.resolveNs(domain)          → DNS host (matched against REGISTRARS)
                └─ whois(domain) ‖ RDAP(domain)   → registrar of record (parallel; whois preferred)
             ← {registrar, automated, ns, whois_registrar, registrar_source, deep_link}

2. authorize POST /api/cloudflare/install {domain, token}
             POST /api/porkbun/install    {domain, apikey, secretapikey}
                ├─ write _agent + _skill TXT (upsert) via the registrar API
                ├─ writeManifests(domain)          → agent-card.json, skills/index.json
                └─ insert install row (status=installed)
             ← {success, record_ids}

3. verify    POST /api/verify {domain}
                └─ dns.resolveTxt(_agent.{d}), dns.resolveTxt(_skill.{d})
             ← {agent:{ok,value}, skill:{ok,value}}   (mark verified when both ok)
```

`writeManifests` is also called from `/api/verify`, so the manifest URLs in the TXT records
resolve even for the manual flow where we never wrote the records ourselves.

## Detection

Two independent signals, because they answer different questions:

- **DNS host** — `dns.resolveNs` returns the authoritative nameservers, which reveal who
  *operates* the DNS (and therefore where records must be written). Matched against the
  `REGISTRARS` table by substring (e.g. `ns.cloudflare.com` → Cloudflare).
- **Registrar of record** — the system `whois` command, with an **RDAP** fallback for TLDs the
  whois client can't map (most newer gTLDs return *"TLD is not supported"*). Run in parallel
  with the NS lookup; the whois answer is preferred, RDAP fills the gap.

A domain can be registered at one company but have DNS delegated elsewhere (e.g. a parked
domain on a marketplace), so both signals are surfaced. Automation keys off the **DNS host**,
since that's where the records actually live. Detection is always real, even in `DEMO` mode.

## The activate modal (front end)

After detection, the whole onboarding lives in one modal driven by a small state machine
(`activate.step`). The page underneath stays on the hero.

```
detect-result ──Continue──▶ authorize ──(automated, success)──▶ activating ──▶ activated
      │                        │  └─(Cloudflare)─▶ authorize-waiting / authorize-popup-blocked
      └─(Unknown / "Other")────┘  └─(manual / coming-soon)──────▶ authorize-manual ──▶ activating
```

- **detect-result** — shows the detected DNS host, with a "different host" override dropdown.
- **authorize** — Cloudflare leads with a popup to its token creator (password/2FA stay on
  cloudflare.com); Porkbun shows credential fields; manual/unknown route to copy‑paste.
- **authorize-waiting / -popup-blocked** — paste‑back token field (auto‑focused when the user
  returns to the tab); blocked‑popup fallback uses a plain new‑tab anchor.
- **activating** — a real verify poll behind a time‑based progress bar.
- **activated** — success; offers the registry link and "install another".

Bulk install reuses the same registrar clients across a list of domains (concurrency‑limited),
with one credential per registrar.

## Storage

`installs (id, domain, registrar, status, created_at, verified_at)` — an audit log of who
onboarded what and when. No credentials, no tokens, no auth state. See `schema.sql`.

## DEMO mode

`DEMO=true` (default) makes the app fully clickable with no external side effects:

| Endpoint | DEMO behavior |
|---|---|
| `/api/detect` | **real** (read‑only) |
| `/api/cloudflare/install`, `/api/porkbun/install` | return success without calling the registrar |
| `/api/verify` | succeeds 8 s after install |

Detection is never mocked because it's safe and the most useful thing to test offline.

## Security boundary

- Registrar credentials are request‑scoped: used for the write, then garbage‑collected. No
  logging path touches the request body's secret fields.
- The Cloudflare popup is on `dash.cloudflare.com`; the app only receives the API token the
  user pastes back.
- Optional 30‑minute `sessionStorage` token reuse is client‑side only and cleared on tab close
  or on a server‑side auth/permission failure.
- HTML is served `no-store`/`no-cache` so the SPA never sticks on a stale build; `/api/detect`
  is `no-store`.
