# Contributing to ADO Installer

Thanks for looking at this. It's a deliberately small codebase — two files do almost
everything — so most changes are contained and easy to review.

By contributing you agree your contributions are licensed under the project's
[MIT license](LICENSE).

## Local setup

```bash
npm install            # builds the better-sqlite3 native addon (needs a C toolchain)
cp .env.example .env   # DEMO=true keeps everything offline
npm run dev            # http://127.0.0.1:4180
```

`DEMO=true` mocks all registrar writes and the verify poll, so you can develop the full UI
without any credentials or live DNS. Detection (`/api/detect`) always runs for real because
it's a read‑only lookup.

## Tech conventions

These are intentional constraints, not accidents — please keep within them:

- **No build step.** `public/index.html` is the entire front end: inline `<style>`, one
  `<script type="module">`, vanilla DOM. No bundler, no framework, no npm front‑end deps.
- **Backend is one file.** `server.js`, ES modules, Express. Keep it readable top‑to‑bottom.
- **Match the surrounding style.** Mono‑terminal aesthetic, the existing CSS variables
  (`--accent`, `--termbg`, …), small pure render functions for modal states.
- **Never store or log credentials.** Tokens/keys are read from the request, used once, and
  dropped. Don't add logging that could capture them; don't persist them server‑side. The only
  client‑side persistence is the documented 30‑minute Cloudflare `sessionStorage` cache.

## Adding a registrar

**Detection only (manual flow):** add a row to `REGISTRARS` in `server.js` (matched against the
domain's NS records) and a matching entry to the client `REGISTRARS` table in
`public/index.html` (used by the "different host" dropdown). The manual copy/paste + deep‑link
flow then works automatically.

**Automated writes:** two pieces —

1. `server.js`: a small API client + a `POST /api/{registrar}/install` endpoint that writes the
   two TXT records (upsert) and returns `{success, record_ids}`. Mirror `cloudflareInstall` /
   `porkbunInstall`. Respect `DEMO` (return a fake success). Never log the credentials.
2. `public/index.html`: an entry in the `AUTOMATED` map describing the credential `fields`, the
   `endpoint`, and the help link. The activate modal renders the fields and wires the call.

Cloudflare additionally has a bespoke popup token flow; most registrars only need the field
form (like Porkbun).

## Testing

There's no test runner; verification is lightweight and manual:

- **Syntax check both files** before committing:
  ```bash
  node --check server.js
  node -e 'const fs=require("fs");const h=fs.readFileSync("public/index.html","utf8");fs.writeFileSync("/tmp/spa.mjs",h.match(/<script type="module">([\s\S]*?)<\/script>/)[1])' && node --check /tmp/spa.mjs
  ```
- **Exercise the API** in `DEMO=true` with `curl` (detect → install → verify).
- **Visual checks** use headless Chrome against a throwaway harness that stubs `state`/`activate`
  and renders a given modal state by URL hash, screenshotting each. This is how the modal states
  were validated during development; reuse the pattern for UI changes.

Please describe what you verified in the PR.

## Pull requests

- One logical change per PR; keep diffs focused.
- Commit messages: `area: imperative summary` (e.g. `authorize: …`, `detect: …`, `fix: …`).
- Note any behavior that you couldn't exercise locally (e.g. a live registrar round‑trip).
