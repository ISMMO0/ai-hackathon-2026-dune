# Connect an agent to your instance

This page shows how to point an agent at a Hackathon Starter instance. There are
two surfaces, both self-contained on your box:

- **The CLI** — for terminal agents (Claude Code, shell loops, CI): sign in,
  pick a workspace, manage items, projects and their members, teams, files and
  demo links, speak and transcribe (`starter speak`, `starter transcribe`), run
  a web task in a cloud browser (`starter run`), export the workspace. Full reference:
  [cli.md](../agents/cli.md).
- **The MCP endpoint** — for MCP hosts (claude.ai connectors, Claude
  Desktop, Claude Code, any MCP client): `get_me`, `list_files` and 26 `starter_` tools
  (`starter_whoami`, the eleven project tools, the two team reads, the seven item tools, the two voice tools and the three run tools), over streamable HTTP at `/mcp`. Full reference:
  [mcp-connector.md](../agents/mcp-connector.md).

Both authenticate against **your instance only**. There is no central
Hackathon Starter service in either path — the key self-host property is that every
instance is its **own OAuth 2.1 authorization server** and its own API-key
issuer, so nothing works or breaks because of anyone else's infrastructure.

## The CLI

Get the binary (`npm i -g @antasphere/starter`, or a workspace build):

```bash
pnpm --filter @antasphere/starter... build
alias starter='node /path/to/starter/packages/cli/dist/bin.js'
```

The CLI has **no default URL** — every command resolves its target as
`--api-url` flag → `STARTER_URL` env → the saved profile's `baseUrl`, and
errors if none is set. That is deliberate: a self-hosted CLI must name its
instance instead of silently talking to the wrong host.

**Sign in, option A — browserless OTP** (requires the instance to have an
email driver). Signs in existing accounts only — sign-up stays closed:

```bash
starter auth login-request  --api-url https://starter.example.com --email you@example.com
starter auth login-complete --api-url https://starter.example.com --email you@example.com --code 123456
```

`login-complete` mints a `ytk_` API key server-side (scopes
`items:read` + `items:write`) and stores it as the active
profile in `~/.config/antasphere/tools/starter.json` (mode 600; the
shared Antasphere CLI config home, see [cli.md](../agents/cli.md)).

**Sign in, option B — paste a dashboard key** (works with `EMAIL_DRIVER=none`,
and required for accounts with 2FA). Mint the key in the dashboard: **API
keys**, then **Create key**. Tick `items:write` there (the dialog
pre-selects `items:read` only) so the key can also write, for example upload
a file; the secret is shown once, right after creation. Then:

```bash
starter login --api-url https://starter.example.com --api-key ytk_...
starter verify    # exit 0 iff instance + key work (it does not check the scopes)
```

**The agent loop** — environment variables, then any command with `--json`:

```bash
export STARTER_URL=https://starter.example.com
export STARTER_API_KEY=ytk_...

starter whoami --json
starter files list --json | jq -r '.files[].id'
```

`--json` on any command except `files download` emits the wire shape for
machine parsing. See [cli.md](../agents/cli.md) for the full command list.

## The MCP endpoint

Every instance serves MCP at:

```
https://your-instance.example.com/mcp
```

Two ways in:

**OAuth (claude.ai / Claude Desktop connectors).** Add the URL as a custom
connector — that is the whole configuration. The client discovers
everything from your instance itself: the 401 challenge points at the RFC
9728 resource metadata, which names _this instance_ as the authorization
server; the client self-registers (RFC 7591), the member signs in on your
dashboard and approves consent, and tokens are minted, verified, and
refreshed entirely by your box. Deactivating the member kills the connector
instantly.

**API key (Claude Code, headless hosts).** `/mcp` accepts the instance's
`ytk_` keys directly, no OAuth dance:

```bash
claude mcp add --transport http starter https://your-instance.example.com/mcp \
  --header "Authorization: Bearer ytk_..."
```

Tools act as the connected user — identity always comes from the verified
credential, never from a tool parameter, and the API's fail-closed scope
allowlist applies unchanged. The tool set is
tabled in [mcp-connector.md](../agents/mcp-connector.md). The `/mcp`
transport caps request bodies at 1 MiB.

Verify an instance end to end:

```bash
curl -s https://your-instance.example.com/.well-known/oauth-protected-resource/mcp | jq
npx @modelcontextprotocol/inspector   # connect → OAuth dance → call get_me
```

## Scopes and revocation

| Credential     | Granted                                                                                             | Revoke                                                |
| -------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `ytk_` API key | The scopes chosen at mint: `items:read`, `items:write`, optional opt-in `data:export`; optional TTL | Dashboard → API keys (immediate)                      |
| OAuth token    | The scopes approved on the consent screen; 15-minute access tokens, rotating refresh                | Deactivate the member, or revoke the client's consent |

Machine credentials reach **only** the endpoints consciously allowlisted for
their scopes (fail-closed — see [security.md](../security/security.md)); member
deactivation is re-checked on every request, so cutting a person off cuts
their agents off in the same moment.
