import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import fetch from 'node-fetch';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DEMO = (process.env.DEMO ?? 'true').toLowerCase() !== 'false';
const PORT = parseInt(process.env.PORT ?? '4180', 10);
const CF_API = 'https://api.cloudflare.com/client/v4';

// ---------------------------------------------------------------------------
// Database — install log only. The Cloudflare token is never stored.
// ---------------------------------------------------------------------------
const db = new Database(path.join(__dirname, 'data.db'));
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
const insertInstall = db.prepare(
  `INSERT INTO installs (domain, registrar, status) VALUES (?, ?, ?)`
);
const markVerified = db.prepare(
  `UPDATE installs SET status='verified', verified_at=datetime('now')
   WHERE id = (SELECT id FROM installs WHERE domain=? ORDER BY id DESC LIMIT 1)`
);

// ---------------------------------------------------------------------------
// Registrar detection (NS -> registrar)
// ---------------------------------------------------------------------------
const REGISTRARS = [
  { match: 'cloudflare.com',        name: 'Cloudflare',    slug: 'cloudflare', deep: 'https://dash.cloudflare.com/?to=/:account/{domain}/dns', automated: true },
  { match: 'domaincontrol.com',     name: 'GoDaddy',       slug: 'godaddy',    deep: 'https://dcc.godaddy.com/control/portfolio/{domain}/settings?subtab=dns', automated: false },
  { match: 'registrar-servers.com', name: 'Namecheap',     slug: 'namecheap',  deep: 'https://ap.www.namecheap.com/domains/domaincontrolpanel/{domain}/advancedns', automated: false },
  { match: 'porkbun.com',           name: 'Porkbun',       slug: 'porkbun',    deep: 'https://porkbun.com/account/domainsSpeedy?search={domain}', automated: true },
  { match: 'squarespacedns.com',    name: 'Squarespace',   slug: 'squarespace', deep: 'https://account.squarespace.com/domains/managed/{domain}/dns-settings', automated: false },
  { match: 'googledomains.com',     name: 'Squarespace',   slug: 'squarespace', deep: 'https://account.squarespace.com/domains/managed/{domain}/dns-settings', automated: false },
  { match: 'awsdns',                name: 'AWS Route 53',  slug: 'amazonaws',  deep: 'https://console.aws.amazon.com/route53/v2/hostedzones', automated: false },
];
const UNKNOWN = { name: 'Unknown', slug: null, deep: null, automated: false };

function matchRegistrar(nsList) {
  const joined = nsList.join(' ').toLowerCase();
  return REGISTRARS.find((r) => joined.includes(r.match)) ?? UNKNOWN;
}

function describeRegistrar(r, domain) {
  return {
    registrar: r.name,
    registrar_slug: r.slug,
    deep_link: r.deep ? r.deep.replaceAll('{domain}', domain) : null,
    automated: r.automated,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizeDomain(input) {
  if (!input || typeof input !== 'string') return null;
  let d = input.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return null;
  return d;
}

// AgentRoot TXT record (inline DNS mode). One record at _agentroot.<domain>.
// Reference: https://www.agentroot.io/publish
// Four-field minimum the /publish UI emits for an MCP record with only Name
// filled; no `endpoint` (we don't claim where the user's MCP server lives).
// `content` is the canonical RAW payload — DNS presentation quotes are added at
// the registrar boundary (Cloudflare wants quoted input; Porkbun wants raw).
const AGENTROOT_PAYLOAD = (domain) => `v=ar1 type=mcp name=${domain.split('.')[0]} transport=sse`;

function records(domain) {
  return [
    { key: 'agentroot', name: `_agentroot.${domain}`, content: AGENTROOT_PAYLOAD(domain) },
  ];
}

const quoted = (s) => `"${s}"`;

// Tracks when a domain was "installed" so DEMO verify can succeed after 8s.
const installedAt = new Map();

// ---------------------------------------------------------------------------
// Cloudflare client — token used once, then it falls out of scope. Never logged.
// ---------------------------------------------------------------------------
async function cf(token, urlPath, options = {}) {
  const res = await fetch(`${CF_API}${urlPath}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await res.json();
  if (!data.success) {
    const msg = data.errors?.map((e) => e.message).join('; ') || `Cloudflare API error (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return data.result;
}

async function cloudflareInstall(domain, token) {
  const zones = await cf(token, `/zones?name=${encodeURIComponent(domain)}`);
  if (!zones.length) {
    throw new Error(`No Cloudflare zone found for ${domain}. Make sure the token has access to this zone.`);
  }
  const zoneId = zones[0].id;

  // Best-effort cleanup of v3.7-era records we wrote (content carries our old
  // v=agentroot1 marker). Unrelated TXT at those names is left alone.
  for (const stale of [`_agent.${domain}`, `_skill.${domain}`]) {
    try {
      const old = await cf(token, `/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(stale)}`);
      for (const r of old) {
        if (r.content?.includes('v=agentroot1')) {
          await cf(token, `/zones/${zoneId}/dns_records/${r.id}`, { method: 'DELETE' });
        }
      }
    } catch { /* best-effort */ }
  }

  const ids = [];
  for (const rec of records(domain)) {
    // Upsert: if a TXT record with this name already exists, replace it.
    // Quote the content so Cloudflare's dashboard doesn't show the
    // "must be in quotation marks" warning; resolvers see the same value.
    const existing = await cf(token, `/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(rec.name)}`);
    const body = JSON.stringify({ type: 'TXT', name: rec.name, content: quoted(rec.content), ttl: 120 });
    const result = existing.length
      ? await cf(token, `/zones/${zoneId}/dns_records/${existing[0].id}`, { method: 'PUT', body })
      : await cf(token, `/zones/${zoneId}/dns_records`, { method: 'POST', body });
    ids.push(result.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Porkbun client — API key + secret used once, then out of scope. Never logged.
// Porkbun has a clean REST API, so this is real automation (not browser scraping).
// ---------------------------------------------------------------------------
const PORKBUN_API = 'https://api.porkbun.com/api/json/v3';

async function pb(urlPath, body) {
  const res = await fetch(`${PORKBUN_API}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (data.status !== 'SUCCESS') {
    // Porkbun's most common failure is API access not enabled on the domain.
    throw new Error(data.message || `Porkbun API error (HTTP ${res.status})`);
  }
  return data;
}

async function porkbunInstall(domain, apikey, secretapikey) {
  const auth = { apikey, secretapikey };

  // Best-effort cleanup of v3.7-era records we wrote (carry the v=agentroot1 marker).
  for (const stale of ['_agent', '_skill']) {
    try {
      const old = await pb(`/dns/retrieveByNameType/${domain}/TXT/${stale}`, auth);
      for (const r of old.records || []) {
        if (String(r.content).includes('v=agentroot1')) {
          await pb(`/dns/delete/${domain}/${r.id}`, auth);
        }
      }
    } catch { /* best-effort */ }
  }

  const ids = [];
  for (const rec of records(domain)) {
    const sub = rec.name.slice(0, -(domain.length + 1)); // "_agentroot.ex.com" -> "_agentroot"
    // Porkbun stores content verbatim and wraps it in quotes itself, so send the
    // RAW payload (no quotes — quoting here would store literal quote chars).
    const existing = await pb(`/dns/retrieveByNameType/${domain}/TXT/${sub}`, auth);
    if (existing.records && existing.records.length) {
      await pb(`/dns/editByNameType/${domain}/TXT/${sub}`, { ...auth, content: rec.content, ttl: '600' });
      ids.push(String(existing.records[0].id));
    } else {
      const created = await pb(`/dns/create/${domain}`, { ...auth, name: sub, type: 'TXT', content: rec.content, ttl: '600' });
      ids.push(String(created.id));
    }
  }
  return ids;
}

async function resolveTxtFlat(name) {
  const chunks = await dns.resolveTxt(name); // string[][]
  return chunks.map((parts) => parts.join(''));
}

// ---------------------------------------------------------------------------
// Registrar of record — who the domain is *registered* with (vs. the DNS host
// the NS records reveal). System `whois` first; RDAP fallback for TLDs the
// whois client can't map (most newer gTLDs return "TLD is not supported").
// `domain` is already validated by normalizeDomain, and execFile takes an arg
// array (no shell), so there's no command-injection surface.
// ---------------------------------------------------------------------------
function whoisRegistrar(domain) {
  return new Promise((resolve) => {
    execFile('whois', [domain], { timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err || !stdout || /TLD is not supported|No match for|NOT FOUND|no entries found/i.test(stdout)) return resolve(null);
      const m = stdout.match(/^\s*Registrar:\s*(.+?)\s*$/im);
      resolve(m ? m[1].trim() : null);
    });
  });
}

async function rdapRegistrar(domain) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const ent = (data.entities || []).find((e) => (e.roles || []).includes('registrar'));
    if (!ent) return null;
    const vcard = ent.vcardArray?.[1] || [];
    const fn = vcard.find((x) => x[0] === 'fn');
    return (fn && fn[3]) || ent.handle || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Runs both in parallel; prefers the system whois answer, RDAP as fallback.
async function lookupRegistrar(domain) {
  const [w, r] = await Promise.all([whoisRegistrar(domain), rdapRegistrar(domain)]);
  if (w) return { name: w, source: 'whois' };
  if (r) return { name: r, source: 'rdap' };
  return { name: null, source: null };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Detection is ALWAYS real — it's a read-only NS lookup. DEMO only mocks
// the writes (install) and verify, never which registrar a domain is on.
app.post('/api/detect', async (req, res) => {
  const domain = normalizeDomain(req.body?.domain);
  if (!domain) return res.status(400).json({ error: 'Enter a valid domain, e.g. mycompany.com' });
  res.set('Cache-Control', 'no-store'); // detection is live, never cached
  // whois adds latency; bulk opts out with { whois: false } since it only needs the DNS host.
  const wantWhois = req.body?.whois !== false;
  try {
    const [ns, reg] = await Promise.all([
      dns.resolveNs(domain).catch(() => []),
      wantWhois ? lookupRegistrar(domain) : Promise.resolve({ name: null, source: null }),
    ]);
    if (!ns.length && !reg.name) {
      return res.status(404).json({ error: `Could not look up ${domain}. Check the spelling.` });
    }
    res.json({ ...describeRegistrar(matchRegistrar(ns), domain), ns, whois_registrar: reg.name, registrar_source: reg.source });
  } catch {
    res.status(404).json({ error: `Could not look up ${domain}. Check the spelling.` });
  }
});

app.post('/api/cloudflare/install', async (req, res) => {
  const domain = normalizeDomain(req.body?.domain);
  const token = req.body?.token; // single-use; never persisted or logged
  if (!domain) return res.status(400).json({ error: 'Invalid domain' });

  try {
    let record_ids;
    if (DEMO) {
      record_ids = ['demo-agentroot-record'];
    } else {
      if (!token) return res.status(400).json({ error: 'Cloudflare API token required (Zone:DNS:Edit scope).' });
      record_ids = await cloudflareInstall(domain, token);
    }
    installedAt.set(domain, Date.now());
    insertInstall.run(domain, 'Cloudflare', 'installed');
    console.log(`[install] ${domain} -> Cloudflare (${DEMO ? 'demo' : 'live'})`);
    res.json({ success: true, record_ids });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/porkbun/install', async (req, res) => {
  const domain = normalizeDomain(req.body?.domain);
  const apikey = req.body?.apikey;             // single-use; never persisted or logged
  const secretapikey = req.body?.secretapikey; // single-use; never persisted or logged
  if (!domain) return res.status(400).json({ error: 'Invalid domain' });

  try {
    let record_ids;
    if (DEMO) {
      record_ids = ['demo-agentroot-record'];
    } else {
      if (!apikey || !secretapikey) return res.status(400).json({ error: 'Porkbun API key and secret key required.' });
      record_ids = await porkbunInstall(domain, apikey, secretapikey);
    }
    installedAt.set(domain, Date.now());
    insertInstall.run(domain, 'Porkbun', 'installed');
    console.log(`[install] ${domain} -> Porkbun (${DEMO ? 'demo' : 'live'})`);
    res.json({ success: true, record_ids });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

async function checkAgentRoot(domain) {
  try {
    // dns.resolveTxt strips DNS presentation quotes, so we match the raw payload.
    const values = await resolveTxtFlat(`_agentroot.${domain}`);
    const found = values.find((v) => v.startsWith('v=ar1'));
    return { ok: !!found, value: found ?? null };
  } catch {
    return { ok: false, value: null };
  }
}

app.post('/api/verify', async (req, res) => {
  const domain = normalizeDomain(req.body?.domain);
  if (!domain) return res.status(400).json({ error: 'Invalid domain' });

  if (DEMO) {
    if (!installedAt.has(domain)) installedAt.set(domain, Date.now());
    const ready = Date.now() - installedAt.get(domain) >= 8000;
    if (ready) markVerified.run(domain);
    return res.json({ agentroot: { ok: ready, value: ready ? AGENTROOT_PAYLOAD(domain) : null } });
  }

  const result = await checkAgentRoot(domain);
  if (result.ok) markVerified.run(domain);
  res.json({ agentroot: result });
});

// SPA last so it doesn't shadow the API routes. Never let the browser serve a
// stale homepage — always revalidate the HTML.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  },
}));

app.listen(PORT, () => {
  console.log(`ADO Installer listening on http://127.0.0.1:${PORT}  (DEMO=${DEMO})`);
});
