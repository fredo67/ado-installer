# AgentRoot record format

This is the data contract the installer writes. **It should be reconciled with AgentRoot's
canonical specification** ([agentroot.io/publish](https://www.agentroot.io/publish)) — the
value below reflects what this reference implementation produces today (defined by
`AGENTROOT_PAYLOAD` / `records()` in `server.js`, mirrored for display in `public/index.html`).

## The TXT record

One record per domain, with an inline payload — **no JSON manifest is hosted anywhere.**
AgentRoot indexes the TXT record directly.

```
_agentroot.{domain}  TXT  "v=ar1 type=mcp name={label} transport=sse"
```

For `fredhsu.com`:

```
_agentroot.fredhsu.com  TXT  "v=ar1 type=mcp name=fredhsu transport=sse"
```

### Fields

| Field | Value | Meaning |
|---|---|---|
| `v` | `ar1` | AgentRoot spec version |
| `type` | `mcp` | This is an MCP agent endpoint |
| `name` | `{label}` | Short display name — the domain's first label (`fredhsu` for `fredhsu.com`) |
| `transport` | `sse` | How agents should connect |

This is the **four-field minimum** the AgentRoot `/publish` UI emits for an MCP record with
only *Name* filled. It deliberately omits `endpoint` — the installer doesn't claim where the
user's MCP server lives. Users add `endpoint=…` later from `agentroot.io/publish` once they
stand up a server.

### Quoting

The canonical payload data is `v=ar1 type=mcp name=… transport=sse` — the surrounding `"…"`
are DNS presentation quotes, not part of the data:

- **Cloudflare** API is sent the **quoted** form (`"v=ar1 …"`) so the dashboard doesn't show a
  "must be in quotation marks" warning. Cloudflare treats the quotes as delimiters.
- **Porkbun** API is sent the **raw** form (no quotes) — it wraps the value itself; sending
  quotes would store literal quote characters.
- **Manual paste** display shows the quoted form — that's what users paste verbatim.
- **Verification** uses `dns.resolveTxt`, which strips DNS quoting, and matches the `v=ar1`
  prefix — so it works regardless of how the value was stored.

A domain is considered **live on AgentRoot** when `_agentroot.{domain}` resolves to a TXT
value starting with `v=ar1`.

## Points to align with the canonical spec

- The record name (`_agentroot`), the `v=ar1` version tag, and the field keys
  (`type`, `name`, `transport`, optional `endpoint`).
- Whether the four-field set is the canonical minimum for inline DNS indexing, or whether
  `description` / `endpoint` are also required. *(Open question pending confirmation from the
  AgentRoot team — if so, it's a one-line change to `AGENTROOT_PAYLOAD`.)*
- Default `transport` (`sse` vs `streamable-http`) and `type` values.
