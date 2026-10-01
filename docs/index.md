# Hackathon Starter

Hackathon Starter is a tool your team and your agents use through a dashboard, a CLI and an MCP endpoint.
This page lists what an instance gives you today.

## What an instance gives you

- **Workspaces.** Everything lives in one workspace. One person can belong to several workspaces,
  with a different role in each. [Workspaces](concepts/workspaces.md)
- **Members and roles.** A workspace has owners, admins and members. On a self-hosted instance,
  people join through the first-boot setup or through an invitation, and sign-up is closed. On
  cloud, membership is managed at Antasphere.
- **API keys.** A member mints scoped `ytk_` keys in the dashboard. The scopes are `items:read`,
  `items:write` and the opt-in `data:export`. A key can carry an expiry, and revoking it takes
  effect at once.
- **The audit log.** The dashboard has an audit page for the workspace.
- **Files.** A workspace stores files. You upload, list, download and delete them from the
  dashboard, the API or the CLI.
- **The CLI.** The `starter` command signs in, picks a workspace, manages items, projects and their
  members, teams, files and demo links, speaks, transcribes and runs web tasks, and exports the workspace. [The Hackathon Starter CLI](agents/cli.md)
- **The MCP endpoint.** Every instance serves MCP at `/mcp`, behind its own OAuth 2.1
  authorization server or an API key. It lists `get_me`, `list_files` and 26 `starter_` tools: `starter_whoami`, the project tools, the team reads, the item tools, the two voice tools and the three run tools.
  [The MCP connector](agents/mcp-connector.md)
- **Items.** The placeholder resource of the template: a name and a note, per workspace. It is a
  working example, not a stub. The API serves seven routes under `/api/v1/items`: list, create,
  read, update, delete, and the two that put an item in a project and take it out. A key needs
  `items:read` for the two reads and `items:write` for the five writes. The dashboard, the CLI (`starter items`) and the MCP item tools use the same
  routes.
- **The voice and the runs.** The starter's two integrations: Gradium speaks a text and transcribes a
  recording (`POST /api/v1/voice/speak`, `POST /api/v1/voice/transcribe`), and H's agent carries out a web
  task in a cloud browser (`POST /api/v1/runs`, then `GET /api/v1/runs/{id}` until it is done). Each reads its
  key from the environment (`GRADIUM_API_KEY`, `HAI_API_KEY`); without it, its routes answer `503` naming the
  key. The dashboard's Try it page, the CLI (`starter speak`, `starter transcribe`, `starter run`) and the MCP
  tools use the same routes.

## Two ways to run it

- **Antasphere cloud**: [starter.antasphere.com](https://starter.antasphere.com), operated by
  Antasphere. Sign in with your Antasphere account, one account managed at
  `account.antasphere.com` and shared across every Antasphere tool. Organizations and membership
  live there too. See [Your Antasphere account](getting-started/antasphere-account.md).
- **Self-hosted**: one Docker image plus a Postgres container, running entirely on your own machine.
  All state lives in your database and one data volume; nothing phones home. Every instance is its
  own OAuth 2.1 authorization server and API-key issuer, so nothing works or breaks because of
  anyone else's infrastructure. Start at [Install](self-hosting/install.md).

## Where to go next

- **[Connect an agent](getting-started/connect-an-agent.md)**: the five-minute on-ramp, pointing a
  CLI or an MCP host at your instance.
- **[Workspaces](concepts/workspaces.md)**: what a workspace holds, who can create one, and how
  the API and the CLI choose one.
- **[Your Antasphere account](getting-started/antasphere-account.md)**: how sign-in, organizations
  and the CLI work on the cloud edition.
- **[The Hackathon Starter CLI](agents/cli.md)** and **[the MCP connector](agents/mcp-connector.md)**: the two
  agent surfaces in full.
- **[Install](self-hosting/install.md)**, **[reverse proxy](self-hosting/reverse-proxy.md)**,
  **[deployment profiles](self-hosting/deployment-profiles.md)** and
  **[upgrades](self-hosting/upgrade.md)**: run your own instance.
- **[Backup and restore](operations/backup-restore.md)** and the
  **[scaling drill](operations/scaling.md)**: operate it with confidence.
- **[Security posture](security/security.md)**: what every instance enforces, and what the
  operator is responsible for.
- **[Environment reference](reference/env-reference.md)**: every variable.

## License

Hackathon Starter is [fair-code](https://faircode.io), distributed under the
[Sustainable Use License](https://github.com/antasphere/starter/blob/HEAD/LICENSE): the source is
open to read, and you may self-host it, modify it and use it for your own internal business or
personal purposes, free of charge. You may not sell it or offer it to others as a paid or hosted
service. It is source-available, not open source.
