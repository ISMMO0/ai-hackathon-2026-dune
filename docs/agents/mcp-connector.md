# The MCP connector

Every instance is MCP-capable at boot: every instance serves a streamable-HTTP
MCP endpoint at `/mcp`, protected by the instance's own built-in OAuth 2.1
authorization server. No companion service, no shared secrets, no
`aud`/resource URL to keep in sync — the resource identifier is derived at
boot as `PUBLIC_BASE_URL + '/mcp'`.

## claude.ai / Claude Desktop (OAuth)

Add a custom connector with the URL:

```
https://starter.example.com/mcp
```

The client discovers everything itself: the 401 challenge points at the RFC
9728 resource metadata, which points at this instance as the authorization
server; the client self-registers (RFC 7591), the member signs in and
approves the consent screen, and the connector holds a 15-minute access
token with a rotating refresh token. Deactivating the member kills the
connector instantly (tokens are re-checked against the live membership on
every call).

**The grant is user-scoped, not workspace-scoped.** A connected client acts
as you in every workspace you belong to: consent binds no workspace and there
is no per-workspace consent. Each tool takes an optional `workspace` id and
defaults to your default workspace. Connect a client only where you would
trust it with all of them.

## Claude Code / CLIs (API key)

`/mcp` also accepts the instance's API keys directly — no OAuth dance:

```bash
claude mcp add --transport http starter https://starter.example.com/mcp \
  --header "Authorization: Bearer ytk_..."
```

Mint keys in the dashboard (API keys → Create key). Scopes gate what tools can do:
`items:read` for reads, `items:write` for mutations.

## Verify an instance

```bash
curl -s https://starter.example.com/.well-known/oauth-protected-resource/mcp | jq
npx @modelcontextprotocol/inspector   # connect → OAuth dance → call get_me
```

`get_me` returning your identity proves discovery, registration, login,
consent, token exchange, JWKS verification, and the live membership check in
one call.

## The tool set

The endpoint lists 28 tools: the two every instance of the platform serves
(`get_me`, `list_files`) and the 26 under the tool's prefix: `starter_whoami`
(registered by the platform under that prefix), the eleven project tools and the
two team reads every Antasphere tool serves (registered by the platform too: a
project is a subgroup of the workspace, see [Projects](../concepts/projects.md),
and a team is a named group of its members), the five item tools
the two that put an item in a project and take it out, the two voice
tools (Gradium) and the three run tools (H). All act as the
connected user: identity always comes from the verified credential (OAuth token
or API key), never from a tool parameter. A read tool needs `items:read`, a
write tool `items:write`; the API's fail-closed allowlist applies unchanged.
Start with `starter_whoami`.

| Tool                               | Scope         | Does                                                                                                                                                                                                                                                                |
| ---------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_me`                           | `items:read`  | The connected user (`id`, `email`, `name`), the workspace the call resolved to, the role, how the caller signed in, the scopes, and every workspace (an alias of `starter_whoami`)                                                                                  |
| `list_files`                       | `items:read`  | A workspace's files, newest first, with a `nextCursor` for the next page. `limit` is 1 to 100, 50 by default                                                                                                                                                        |
| `starter_whoami`                   | `items:read`  | Who is connected, the scopes, and every organization the user can name in the `workspace` argument, with role and default flag                                                                                                                                      |
| `starter_list_projects`            | `items:read`  | The projects you belong to, newest first, each with your own `myRole`; `archived` lists the archived ones or both. See [Projects](../concepts/projects.md)                                                                                                          |
| `starter_get_project`              | `items:read`  | One project, with your own role on it (a project you are not on answers `not_found`, never a refusal)                                                                                                                                                               |
| `starter_list_project_members`     | `items:read`  | A project's members and their roles (`viewer` < `editor` < `manager`), with a `nextCursor`. Each entry carries `kind`: `person` or `team`                                                                                                                           |
| `starter_create_project`           | `items:write` | Creates a project; you become its first manager. Confirm-first                                                                                                                                                                                                      |
| `starter_update_project`           | `items:write` | Renames a project, changes its description or replaces its `metadata` object (manager). Confirm-first                                                                                                                                                               |
| `starter_archive_project`          | `items:write` | Archives a project, out of the default list and read-only, or brings one back with `archived: false` (manager). A project is never deleted. Confirm-first                                                                                                           |
| `starter_add_project_member`       | `items:write` | Puts one of the workspace's own active members on a project by `userId` or `email`, or one of its teams by `teamId` (every member of the team then holds the role), with a role (manager). Invites nobody, mints no account. Confirm-first                          |
| `starter_set_project_member_role`  | `items:write` | Changes a project member's role (manager). Confirm-first                                                                                                                                                                                                            |
| `starter_remove_project_member`    | `items:write` | Takes someone off a project (manager; anyone may remove themselves). They stay a workspace member. Destructive, confirm-first                                                                                                                                       |
| `starter_set_project_team_role`    | `items:write` | Changes the role a team holds on a project (manager). Confirm-first                                                                                                                                                                                                 |
| `starter_remove_project_team`      | `items:write` | Takes a team off a project (manager). Its people keep their own entries; the team stays in the workspace. Destructive, confirm-first                                                                                                                                |
| `starter_list_teams`               | `items:read`  | The workspace's teams (named groups of its members), with a `nextCursor`. On a workspace managed by the Antasphere account site they come from there; teams are shaped on the People page or the account site, never over MCP                                       |
| `starter_list_team_members`        | `items:read`  | One team's members, with a `nextCursor` (`role` is their workspace role)                                                                                                                                                                                            |
| `starter_list_items`               | `items:read`  | The items of the workspace, newest first, with a `nextCursor` for the next page; `projectId` keeps the items in one project. Every item carries `projects: [{ id, name }]`, the ones you can read. `limit` is 1 to 100, 50 by default                               |
| `starter_get_item`                 | `items:read`  | One item by id, its `projects` included. `not_found` for an id that is not in this workspace                                                                                                                                                                        |
| `starter_create_item`              | `items:write` | Creates an item: a `name` (1 to 200 characters) and an optional `note` (up to 2000); `projectIds` puts it in those projects in the same transaction (editor or manager of each, none archived, else the whole create is refused). Confirm-first                     |
| `starter_update_item`              | `items:write` | Changes the `name` and/or the `note`; refuses a call with neither. Confirm-first                                                                                                                                                                                    |
| `starter_delete_item`              | `items:write` | Deletes an item and answers its final snapshot. Destructive, confirm-first                                                                                                                                                                                          |
| `starter_link_item_to_project`     | `items:write` | Puts an item in a project so its members find it there (the editor or manager role on the project; not found / refused / archived, in that order). Confirm-first                                                                                                    |
| `starter_unlink_item_from_project` | `items:write` | Takes an item out of a project (the editor or manager role on the project; not found / refused / archived, in that order); `not_linked` when it was not in it. Destructive, confirm-first                                                                           |
| `starter_voice_speak`              | `items:write` | Speaks a `text` (1 to 2000 characters) with Gradium: an audio content block (the wav, base64) and a line saying its type and size. Spends the workspace’s Gradium credits. Confirm-first                                                                            |
| `starter_voice_transcribe`         | `items:write` | Transcribes a wav passed base64 in `audio`, with an optional `language` (`en`, `fr`, `de`, `es`, `pt` or `any`; without a language, Gradium detects it (`any`)); answers `{ text }`. The 1 MiB `/mcp` body cap bounds the file (about 750 KB of wav). Confirm-first |
| `starter_run_start`                | `items:write` | Starts a run: H’s agent carries out an `instruction` (1 to 2000 characters) in a cloud browser, from the optional https `startUrl`. Answers at once, `running`, with the `liveUrl` of the browser. Confirm-first                                                    |
| `starter_run_get`                  | `items:read`  | One run, brought up to date with H: `state`, `liveUrl`, the `answer` once `completed`, the `error` once `failed`. A run takes 20 seconds to several minutes: call it again until `state` is not `running`                                                           |
| `starter_list_runs`                | `items:read`  | The runs of the workspace, newest first, as last seen, with a `nextCursor`                                                                                                                                                                                          |

A guest of a workspace lists no item, reads `not_found`, and is refused the
write tools and every project tool, exactly as through the API.

Each tool takes an optional `workspace` id and defaults to your default
workspace. No tool uploads or downloads a workspace file: that happens through the API
or the CLI ([CLI reference](cli.md)); the voice tools carry their audio in the call itself. The `/mcp` transport caps request
bodies at 1 MiB.

## How the tools are built

The first three tools (`get_me`, `list_files`, `starter_whoami`) and the nine project tools are registered by
`packages/chassis-server/src/mcp/server.ts`, the last ten under the prefix of the tool's identity. The tool's own
set is declared in `apps/server/src/mcp/tools.ts`. Conventions: reads declare `readOnlyHint` and check `items:read`;
writes describe themselves as confirm-first and check `items:write`
(tool-level checks are UX — the API's fail-closed allowlist in
`middleware/scopes.ts` is the enforcement point); tools call the instance's
own API in-process forwarding the caller's bearer (MCP is just another API
client — never a privileged path); the acting user is NEVER a tool
parameter (identity comes from the verified credential); map domain error
codes to model-readable hints (the constant `ITEM_ERROR_HINTS` in
`apps/server/src/mcp/tools.ts`, which fills the chassis's `errorHints` slot).
New behavior lands in the API first — the MCP tool is a thin projection of it.
