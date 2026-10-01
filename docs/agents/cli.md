# The Hackathon Starter CLI

`starter` is the typed command-line client for a Hackathon Starter instance. It
signs in over email OTP (minting its own API key) or with a pasted key, picks
a workspace, manages the workspace's items, projects and files, speaks and
transcribes through Gradium, runs web tasks through H, and exports the workspace. What
each release added is the Changelog page of the docs site, generated from the
repository's release tags; this page describes the current CLI.

## Install

`npm i -g @antasphere/starter` exposes the `starter` binary (the package
publishes under the Antasphere org's npm scope; the binary name is unchanged).
The published package is a single self-contained bundle (`dist/bin.js`, built
with esbuild): the workspace-internal `@app/contract`, `@app/sdk`,
`@antasphere/cli-core`, and commander are inlined at build time, so the
published manifest carries **zero runtime dependencies** — nothing internal or
git-pinned leaks into a public install.

From a checkout:

```bash
pnpm --filter @antasphere/starter... build
node packages/cli/dist/bin.js --help
node packages/cli/dist/bin.js --version   # the CLI's own version
```

## Configuration: profiles, flags, environment

Config lives in the **shared Antasphere CLI config home** (provided by
`@antasphere/cli-core` — one home for the whole tool family), under the
`starter` namespace: `$XDG_CONFIG_HOME/antasphere/tools/starter.json`
(default `~/.config/antasphere/tools/starter.json`), directories `0700`,
file `0600`:

```json
{
  "activeProfile": "default",
  "profiles": {
    "default": { "apiKey": "ytk_…", "baseUrl": "https://starter.example.com" }
  }
}
```

**Migrating from older builds**: the config used to live at
`~/.config/starter/config.json`. On first run, if that file still exists,
holds at least one profile, and the new home has no starter profiles yet,
it is imported automatically and non-destructively — the old file stays in
place (older CLI builds keep working) but stops being read. Note the
corollary: after `starter config clear`, a still-present legacy file is
imported again on the next run; delete `~/.config/starter/config.json` too
if you want a truly clean slate.

Every command accepts `--api-url` (alias `--url`), `--api-key`, `--profile`,
`--workspace`, and `--json`. Resolution order:

| Setting   | 1st           | 2nd                 | 3rd                         | Otherwise                                                                     |
| --------- | ------------- | ------------------- | --------------------------- | ----------------------------------------------------------------------------- |
| Base URL  | `--api-url`   | `STARTER_URL`       | profile `baseUrl`           | **error**                                                                     |
| API key   | `--api-key`   | `STARTER_API_KEY`   | profile `apiKey`            | hub connect (cloud, below) — else the public commands work and the rest error |
| Workspace | `--workspace` | `STARTER_WORKSPACE` | profile `activeWorkspaceId` | the server's default workspace                                                |

**Choosing the workspace**: an API key identifies a person, and a person can
belong to several workspaces. `--workspace <id or name>` (or
`STARTER_WORKSPACE`, or the selection `starter workspace use` saves on the
profile) names the one a command runs in; with none, the server picks your
default workspace. The value is a Hackathon Starter workspace id as `starter
workspaces` prints it, or a workspace name, matched without regard to case; a
name that matches several workspaces, or none, is an error that lists the
candidates. An id is sent as it is, a name costs one extra request to look it
up, and `workspace use` always saves the id. The saved selection applies only
to the instance its profile names, and `starter logout` removes it.
`starter whoami` shows the workspace the command ran in and what chose it.
The server's default is yours to choose: `starter workspace default <id or name>` on a
self-hosted instance, your Antasphere account on the cloud, where the command answers with the page.
A key pinned to one workspace only ever acts there: selecting another one is
refused, and the error names the pin.

**Keeping secrets out of `argv`**: a value passed as `--api-key ytk_…` is
visible to every process on the machine (`ps`) and lands in the shell
history. Two alternatives do not touch the command line: `--api-key-stdin` reads the key from the first line of stdin
(`pass show starter | starter --api-key-stdin files list`), `STARTER_API_KEY`
carries it in the environment. stdin can only be spent
once per invocation — asking twice is a usage error rather than two commands
silently sharing one secret.

There is deliberately **no default URL**: a self-hosted CLI must name its
instance explicitly (flag, env, or saved profile) rather than silently talking
to the wrong host.

### Cloud instances: connect through `antasphere login`

On an **Antasphere-cloud** instance you never run a Hackathon Starter-specific login.
When no direct key resolves, the CLI asks discovery (`GET /api/v1/instance`)
whether the instance signs in through the hub (`auth.methods` contains
`antasphere`); if so, it exchanges the stored `antasphere login` credential
for a **user-scoped** tool-local `ytk_` key (hub → tool; see
[Your Antasphere account](../getting-started/antasphere-account.md)) and
caches it in the profile **per hub profile** (`connectKeys` — ONE
key per hub account, valid for every org; the org is a per-request
selection, never part of the credential):

```bash
antasphere login                       # once, for the whole tool family
starter files list --api-url https://starter.antasphere.com   # exchanges + caches on first use
starter files list                                      # served from the cache — no hub call, no new key
```

- The exchange names **no organization** (the hub credential identifies the
  USER, never one org); a single cached key serves whatever org context is
  active. Second and later runs make zero hub calls and mint nothing.
- The hub key is sent to the **hub only**; the instance sees a short-lived
  user-scoped JWT (plus its own one-time offline grant, relayed once and
  never stored by the CLI) and answers with an ordinary local key.
- A cached key is only ever replayed against the instance it was minted on
  (the profile's `baseUrl` scopes the cache).
- `starter logout` on a hub-connected profile self-revokes the cached
  key(s) server-side (`DELETE /cli/auth/key` — the presenting key revokes
  exactly itself), then evicts them. An OLDER instance whose machine
  allowlist predates the self-revoke refuses (403) and keeps the key
  **valid server-side** — the CLI says so; revoke it from the dashboard. A
  classic single-key profile logs out exactly as before.

Self-hosted (`oss`) instances never take this branch: the flows above
(`auth login-request`, `login`, `STARTER_API_KEY`, `--api-key`) resolve
exactly as documented, and the hub is never contacted.

## Sign in

The OTP flow is the **self-host** entrance. On an Antasphere-cloud instance
it refuses — the CLI detects cloud via discovery and steers you to
`antasphere login` (see "Cloud instances" above); server-side the endpoints
answer `403 cli_otp_disabled` (cloud instances are hub-login-only). The
flow needs the instance to have a delivering email driver
(`EMAIL_DRIVER=smtp|resend|brevo`); it signs in **existing accounts only** — sign-up
stays closed (accounts enter via setup or workspace invitations):

```bash
starter auth login-request  --api-url https://starter.example.com --email you@example.com
starter auth login-complete --api-url https://starter.example.com --email you@example.com --code 123456
```

`login-complete` mints a `ytk_` API key server-side (scopes
`items:read` + `items:write`, never `data:export`) and stores
it as the active profile; `--key-name <name>` names the key as the dashboard
lists it, and `--expires-in-days <n>` gives it a TTL (it never expires
otherwise). Accounts with 2FA enabled are refused
(`two_factor_required`), and an instance with no email driver has no OTP at
all — mint a key in the dashboard instead (**API keys**, **Create key**; tick
`items:write`, which the dialog leaves unchecked, when the key must also write)
and paste it:

```bash
starter login --api-url https://starter.example.com --api-key ytk_…   # or pipe the key on stdin
```

Profile management:

```bash
starter whoami            # identity behind the resolved key
starter verify            # exit 0 iff instance + key work
starter profiles          # list profiles (keys redacted)
starter use <profile>     # switch the active profile
starter logout            # forget the stored key (revoke server-side in the dashboard);
                            # hub-connected profiles: revoke + evict the cached user-scoped key
starter config show       # config path + redacted contents
starter config clear      # delete the config file
```

## Workspaces, files, export

```bash
starter instance            # public discovery — no key needed
starter workspaces          # your workspaces: id, role, name; * = the one the commands run in, (default) = the server's
starter workspace use <id or name>   # save the selection on the profile (the id is what is stored)
starter workspace use --clear        # remove it: commands run in the server's default again
starter workspace default <id or name>   # self-hosted: choose the server's default, for every key and session of yours
starter workspace default --clear        # remove the choice: the workspace you joined first is the default again
starter files list [--all]
starter files upload <path> [--name <stored name>] [--content-type <type>]
starter files rm <id>
starter files download <id> [--dir ./here]  # writes the stored name (basename only) into --dir
starter files download <id> --out ./exact/path.bin   # …or a path you choose, verbatim
starter export [-o file]    # workspace zip (key needs the opt-in data:export scope)
```

## Items

The items of the workspace the command runs in: a name (1 to 200 characters,
one line) and a free-text note (up to 2000 characters). Every member reads and
writes them; a key needs `items:read` for `list` and `show`, `items:write` for
`create`, `update` and `rm`. The workspace zip of `starter export` carries them
as `items.json`, and their project links as `item_projects.json`.

```bash
starter items list [--limit <n>] [--cursor <cursor>]   # id, creation time, name; newest first
starter items list --all                               # every page, the cursors followed
starter items list --project <id>                      # only the items in this project
starter items create --name <name> [--note <note>]     # prints the new id
starter items create --name <name> --project <id>      # …and puts it in the project (repeatable)
starter items show <id>                                # name, note, projects, author, timestamps
starter items update <id> [--name <name>] [--note <note>]   # at least one; --note "" clears the note
starter items rm <id>                                  # prints what was deleted
```

`items update` with neither `--name` nor `--note` is refused before any
request. An id that is not in this workspace answers `Item not found`, the
same as an id that does not exist; with a workspace selected, the error names
the selection so you can check it.

`items list` shows a projects column only when a listed item sits in one, so
a workspace that uses no project keeps the table it always had; `items show`
prints a `projects:` line the same way. Both name the projects you can read
and no other.

## Voice

The instance's voice, through Gradium: `speak` turns a text into a wav file,
`transcribe` turns a wav file into text. Both spend the workspace's Gradium
credits, so a key needs `items:write` and a guest is refused. Nothing is
stored on the instance.

```bash
starter speak "Bonjour"                      # writes speech.wav, prints its path
starter speak "Bonjour" -o hello.wav         # --out <path>: another file
starter transcribe speech.wav                # prints the text
starter transcribe speech.wav --language fr  # en, fr, de, es, pt or any
```

`--json` prints the wire shape: `{ audio, contentType }` (the wav base64
encoded, no file written) for `speak`, `{ text }` for `transcribe`. When nothing
was heard, `transcribe` prints `Nothing was heard in the recording.` to stderr,
nothing to stdout, and exits 0 (with `--json`, `{ "text": "" }` as always). A text over
2000 characters, a file over 5 MiB, a missing file and a language other than
`en`, `fr`, `de`, `es`, `pt` or `any` are refused before any request. Without a
language, Gradium detects it (`any`). An instance that has no
`GRADIUM_API_KEY` answers `Gradium is not configured: set GRADIUM_API_KEY in
the .env file and restart the server`, and the command exits 1.

## Runs

A run is a web task H's agent carries out in a cloud browser: you say what to
do in plain words, optionally where to start, and the agent answers in plain
text. A run is `running` until it is `completed` (with the answer) or `failed`
(with the reason); one takes from 20 seconds to several minutes. A key needs
`items:read` for `runs list` and `runs show`, `items:write` for `run`; a guest
is refused `run`. The workspace zip of `starter export` carries them as
`runs.json`.

```bash
starter run "What is the heading of example.com?"          # prints the id, the state, the live view
starter run "Read the title" --start-url https://example.com   # the https page the browser starts on
starter run "What is the heading of example.com?" --wait   # every 3 s until done, then the answer
starter runs list [--limit <n>] [--cursor <cursor>] [--all]  # id, creation time, state, instruction
starter runs show <id>                                      # the run, asked of H while it is running
```

The live view is H's page for the session: watch the browser while it works,
replay it after. `--wait` prints each state change, then the answer; a failed
run ends on `Error: The run failed: <reason>` and exit 1. `--json` prints the
wire shape (with `--wait`, the final run). `runs list` shows each run as last
seen and asks H nothing; `runs show` (and `--wait`) asks H where a running run
is. An instance without `HAI_API_KEY` answers `H is not configured: set
HAI_API_KEY in the .env file and restart the server`. A run that H has not
finished after 15 minutes fails with `timed out waiting for H`.

## Projects

A project is a subgroup of the workspace: a name, a description, its own
members with one of three roles (viewer < editor < manager), and the items
linked to it. A workspace's owners and admins act as managers on every project;
any other member creates one and becomes its first manager. A project is
archived, never deleted: archived, it leaves the default list and takes no
change but its unarchive. A key needs `items:read` for the reads and
`items:write` for the writes, the same two scopes as the items.

```bash
starter projects list                          # the projects you belong to
starter projects list --archived all           # …the archived ones too (false | true | all)
starter projects get <project>                 # one project, with your own role on it
starter projects create "Atlas" --description "The launch work"
starter projects create "Atlas" --metadata '{"client":"acme"}'
starter projects update <project> --name "Atlas 2026" --description "…"
starter projects update <project> --clear-description
starter projects update <project> --metadata '{"client":"acme"}'
starter projects archive <project>             # read-only, out of the default list. Never deleted
starter projects unarchive <project>           # …and writable again
starter projects members list <project>
starter projects members add <project> ada@acme.co --role editor
starter projects members add <project> <userId> --role manager
starter projects members add <project> --team design --role editor   # a team: every member of it holds the role
starter projects members role <project> <userId> viewer
starter projects members role <project> design manager --team         # …a team's role
starter projects members remove <project> <userId>
starter projects members remove <project> design --team               # take a team off; its people keep their own entries
starter projects link <project> <item>         # put an item in the project
starter projects unlink <project> <item>       # take it back out
starter items list --project <project>         # only the items in the project
starter items create --name "…" --project <project>   # create the item in the project
```

**The projects themselves** page like every other listing (`--cursor`,
`--limit`, `--all`) and take `--json`. `list` shows the live projects;
`--archived true` shows the archived ones and `--archived all` both.
`create` makes you the project's first manager and takes `--description` and
`--metadata` (a JSON object of your own, opaque to the server); `update` takes
`--name`, `--description` or `--clear-description`, and `--metadata`, which
replaces the whole object. `archive` takes a project out of the default listing
and makes it read-only; nothing is ever deleted, and `unarchive` brings it back.

**Members** come from the workspace's own roster, named by email (anything with
an `@`) or by user id. `add` takes a required `--role viewer|editor|manager`.
A manager removes anyone; anyone removes themselves. A stranger's address is
`No active member of this workspace matches — check the user id or email. Only a
member of the workspace can join a project.`, and a guest of the workspace is
refused with `That person is a guest of the workspace, and a guest cannot be a
project member. Invite them as a workspace member first.`

**A team is a member too.** `add --team <team>` (a slug or an id, in place of
the person) puts one of the workspace's [teams](#teams) on the project with the
role, and every member of the team holds it; `role` and `remove` take `--team`
to name a team as their second argument. `members list` prints a `person` or
`team` column first, then the user id or the team's slug. A person's role on
the project is the highest of their own entry and their teams' entries.

**link / unlink** are the item's side. Both change what the project holds, so
both ask the editor role or more on a live project, and a project you cannot
read answers the same to both: `No such project, or it is not yours to read.`
Both print the projects the item is in afterwards, and `--json` is the item
payload verbatim.

**`--project <id>`** on `items list` keeps the items linked to the project. A
project you cannot read answers the same way the project itself does, so the
filter refuses with `No such project, or it is not yours to read.` rather than
an empty page. On `items create` it is repeatable, and the links ride in the
create itself: one transaction, and a project that does not qualify refuses the
whole create, so an item is never half-placed.

The refusals every project verb shares read as sentences: `No such project, or it
is not yours to read. (A project you are not a member of answers the same way:
its existence is not probeable.)`, `You need the editor role on this project to
put an item in it.`, `This project is archived and read-only. Unarchive it first
to change what it holds.`, and `You are a guest of this workspace, and guests do
not take part in projects.`

## Teams

A team is a named group of the workspace's people, which a project can take as a
member. Every member of the workspace reads the teams; an owner or an admin
shapes them. On a workspace managed by the Antasphere account site, the teams are
read here and managed there.

```bash
starter teams list                             # every team: slug, name, members, yours, created
starter teams get <team>                       # one team (<team> is a slug or an id)
starter teams create "Design"                  # the slug is made from the name…
starter teams create "Design" --slug design    # …or given
starter teams rename <team> --name "Design Ops" --slug design-ops
starter teams delete <team> --yes              # the people stay in the workspace
starter teams members <team>                   # every member of the team
starter teams add <team> ada@acme.co           # seat a member of the workspace, by email or user id
starter teams remove <team> <userId>           # unseat them (an email works too)
```

`list` and `members` read every page, and every verb takes `--json` (the API
answer verbatim). A team from the Antasphere account site is marked
`(Antasphere)` in `list`. The refusals read as sentences: `Only an owner or an
admin manages teams.`, `Teams of this workspace are managed on the Antasphere
account site: <link>`, `A team of this workspace already uses the slug
"design".`, and `ada@acme.co is already in this team.`

## Demo links

On a self-hosted instance whose operator turned demo sign-in on
([Demo links](../self-hosting/demo-links.md)), an owner makes a
link that signs one member in without a password, for a demonstration.

```bash
export STARTER_OWNER_EMAIL=owner@example.com
read -rs STARTER_OWNER_PASSWORD && export STARTER_OWNER_PASSWORD
starter demo link --email ada@example.com                         # one link, a day, landing on /
starter demo link --email ada@example.com --path /items --path /settings --hours 2
starter demo link --email ada@example.com --email bob@example.com  # one sign-in, one pass each
starter demo link --email ada@example.com --minutes 30 --json     # { passes: [{ pass, links: [{ path, url }] }], refused: [] }
starter demo list                                                 # the passes, newest first
starter demo revoke <id>                                          # and the sessions it opened
pass show demo-owner | starter demo list --owner-email owner@example.com --owner-password-stdin
```

**These commands never use an API key.** The instance refuses every machine
credential on its demo routes, so each command signs in as the owner for its
own length and signs out when it ends, whatever happened. The owner's address
is `--owner-email` or `STARTER_OWNER_EMAIL`; the password is
`STARTER_OWNER_PASSWORD` or, with `--owner-password-stdin`, the first line of
stdin. There is no password flag (a password on a command line lands in the
shell history), and nothing (address, password, session) is written to the
profile. The instance comes from the usual `--api-url` / `STARTER_URL` /
profile, and `--workspace` selects the workspace as for every command. An owner
with a second factor is refused: mint that owner's links from the dashboard.

**`demo link`** mints ONE pass per member `--email` names (repeatable: several
members cost one sign-in) and prints, for each, one link per `--path`
(repeatable), all opening that member's pass; the first `--path` is the pass's
own page, and with none it is `/`. A member the instance refuses does not stop
the others: the command names who was refused and why, and exits 1. Each page must be a path on the
instance (one leading `/`, no `#`, no space), checked before any sign-in.
`--hours <n>` or `--minutes <n>` sets the lifetime (a day by default, a week at
most; not both). The human output is the person, the expiry, then the links one
per line; `--json` is `{ passes: [{ pass, links: [{ path, url }] }], refused:
[{ email, code, message }] }`, and the links are the only place the secret ever
appears. Keep them like a password until they expire.

The instance allows three sign-ins per ten seconds from one address. A script
that runs several demo commands in a row meets that limit: the command waits
it out (a few seconds, three times at most) and says so on stderr. Name every
member on ONE `demo link` to sign in once.

**`demo list`** prints each pass's id, the person's address, the page, the
expiry, the revocation, the last use and the number of uses (`--json`:
`{ passes }`). **`demo revoke <id>`** revokes a pass and ends every session it
opened (`--json`: the pass).

The refusals are the instance's own sentences: no member of the workspace holds
that address, a link cannot open another owner's account, the address is not a
demonstration address (a reserved example or test domain, or one in
`DEMO_SIGN_IN_EMAIL_DOMAINS`), the account has a second factor, the person is a
guest or belongs to another workspace, or the page is not a path on this
instance. On an instance where the switch is off, and on the cloud edition,
every demo command says: `Demo sign-in is off on this instance (DEMO_SIGN_IN), or
this is the cloud edition, where demo links are minted at the Antasphere hub.`

## Paging

Every listing command (`items list`, `projects list`, `projects members list`, `files list`) answers one page at a time, newest first:
`--limit <n>` sets the page size (1 to 100) and `--cursor <cursor>` resumes
from the `nextCursor` a previous page printed. `items list`, `files list` and the
two project listings also take `--all`, which follows the cursors until every page is fetched.

## Shell completion

```bash
eval "$(starter completion bash)"     # or zsh
starter completion fish | source      # fish
```

## Machine use

Add `--json` to any command except `files download` for the wire shape; every error prints to stderr
and exits non-zero. Typical agent loop:

```bash
export STARTER_URL=https://starter.example.com
export STARTER_API_KEY=ytk_…
starter items list --json | jq -r '.items[].id'
starter files list --json | jq -r '.files[].id'
```

## Server endpoints behind `auth login-*`

`POST /api/v1/cli/auth/request` and `POST /api/v1/cli/auth/complete` are
public pre-auth endpoints (like `/setup`), riding the better-auth email-OTP
plugin with `disableSignUp` — an unknown email gets a generic success and no
mail (no account enumeration, no account creation), codes are attempt-limited
(3) and both endpoints sit behind the instance's OTP/login rate walls. The
key is returned exactly once; the flow's throwaway session is deleted
server-side. Without an email driver both answer `400 otp_unavailable`; on
the cloud edition both answer `403 cli_otp_disabled` (hub-only login — mint
through `antasphere login` instead). `DELETE /cli/auth/key` is the logout
counterpart on both editions: an authenticated route where the presenting
API key revokes exactly ITSELF (machine-allowed under `items:write`
in the fail-closed scope allowlist; sessions are refused — the dashboard is
their key surface).
