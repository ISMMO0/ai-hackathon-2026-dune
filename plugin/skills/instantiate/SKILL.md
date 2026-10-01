---
name: instantiate
description: Make a new tool out of the Antasphere tool template by giving the repository the tool's name with `pnpm instantiate`. Use it when someone says "make a tool from the template", "instantiate the template as <name>", "rename this tool", or when a run of `pnpm instantiate` refused to start or ended with exit 1 and you must say why. It covers the inputs to decide first, the scaffold with fresh history, the run, the proof that nothing of the old name is left, the gate, and the first commit. What comes after the rename (the workspace, the fleet, the hub, the docs) is the page `docs/getting-started/make-a-tool.md` of the template and the skills `deploy-on-fleet` and `federate-to-hub`.
---

# Make a tool from the template

One script does the rename: `scripts/instantiate.mjs`, run as `pnpm instantiate`. It reads the
name the repository carries today, writes the new one in the files listed in the table at its
top, and proves that the old name stands nowhere else. This skill walks the run and its checks.

Examples use an invented tool: slug `examplenotes`, display name `Example Notes`, domain `examplenotes.example.com`.

## Before you start

- [ ] `git`, Node 22 or later and `pnpm` are installed.
- [ ] The person has decided the four inputs below. Do not pick them for the person.
- [ ] You can read the template repository, `antasphere/tool-template`.

## The inputs

| Input        | Flag            | Rule                                                                                                                                                                           | Default                 |
| ------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Slug         | first argument  | One lower-case word, letters and digits, 3 to 31 characters, starts with a letter, NO hyphen. It becomes the repository name, the image name, the env prefix, the CLI command. | none, required          |
| Display name | `--name`        | One line of plain text. No quotes, backslashes or angle brackets.                                                                                                              | none, required          |
| Domain       | `--domain`      | The FINAL public hostname. The hub client, its redirect URI and every grant derive from it later.                                                                              | `<slug>.antasphere.com` |
| CLI package  | `--cli-package` | The npm name of the tool's CLI. It must be free on npm.                                                                                                                        | `@antasphere/<slug>`    |

**The law of a name: a word the tree does not use.** The script refuses, before it writes
anything, a slug or a display name that already stands anywhere in the tracked tree, in any
casing, and prints the first places. The template's sample data says `Acme` and `Beta`
(`ORG_ACME`, `'Beta Board'`), so `acme` and `beta` are refused: a tool with such a name could
never be told from those lines, and a later rename would merge them. This is why the examples
here say `examplenotes`. `--domain` must be a lower-case DNS hostname and `--cli-package` an npm
package name: anything else is refused too.

The script also refuses a slug that is a word the code uses for something else (`tool`, `app`,
`items`, `server`, `chassis` and the like; the list is `RESERVED` in the script). Pick a name
only this tool carries.

## Steps

1. **Scaffold with fresh history.** Never use GitHub's template button and never keep the
   template's `.git`: the tool must not carry the template's history.

   ```bash
   git clone git@github.com:antasphere/tool-template.git examplenotes
   cd examplenotes
   rm -rf .git
   git init -b dev
   git add -A
   git commit -m "chore: scaffold from tool-template"
   ```

2. **Install.** `pnpm install`. The script formats what it changed with the repository's own
   prettier, so the dependencies must be there.

3. **Look before you write.** A dry run prints the files the run would change and writes nothing.

   ```bash
   pnpm instantiate examplenotes --name "Example Notes" --domain examplenotes.example.com --dry-run
   ```

   After pnpm's own banner, look for the line that holds `->`. It names the identity the tree
   carries today, then the one asked for, the domain and the CLI package. The old identity is
   whatever the template carries: read it here, do not expect a particular word. Check the new
   values with the person before step 4.

   pnpm prints `[WARN] The "pnpm" field in package.json is no longer read` on every command in
   this repository. It is not about the run.

4. **Run it.**

   ```bash
   pnpm instantiate examplenotes --name "Example Notes" --domain examplenotes.example.com
   ```

   In order, the run: refuses a dirty tree; removes what only the template carries (the page
   `docs/getting-started/make-a-tool.md`, its line in `docs/nav.yml`, the "Make a tool" section
   of `README.md`, the job `instantiate-proof` of `.github/workflows/ci.yml`); rewrites the
   name in the files of its table `WRITES`, never through a symbolic link (a `skipped` line
   names each one); writes `.instantiate.json` at the root, the record of the identity it
   wrote (the domain and the CLI package cannot be read back from anywhere else, and a rename
   needs them); prints one `changed` or `removed` line per file;
   runs `pnpm install` so that `pnpm-lock.yaml` follows the new package names; formats the
   changed files; lists where the old name still stands.

   The install inside the run prints `WARN Failed to create bin at ...` for the CLI (its `dist/`
   is not built yet) and a block `Issues with peer dependencies found`. Both come with a fresh
   install of this repository, renamed or not. Judge the run by its exit code and by step 5.

5. **Read the end of the output.** Find the line `where "<old slug>" still stands:` near the
   end. One more line follows the result, naming the gate of step 7.
   - A line `WARNING: N line(s) inside packages/chassis-* still name "<old slug>"` comes first
     while the chassis copies still spell the first tool's name. It does not fail the run, and
     it is NOT harmless: some of those lines are live values (the product name in every mail
     the tool sends, the MCP server name, the API page title, the telemetry service name). The
     script never writes those copies. The cure is at the chassis source, which must read the
     tool's identity, followed by a fresh copy. Tell the person, with the command the line
     gives to list them.
   - `no line names "<old slug>" outside the N rows of NEVER`, exit 0: the rename is complete.
   - One `file:line:text` per survivor, exit 1: a file names the tool and the script's table
     does not list it. Do not fix the line by hand and move on: the next tool would meet the
     same survivor. Fix it in the template instead. Either add the file to `WRITES` in
     `scripts/instantiate.mjs`, or (better) make the file read the tool's identity definition,
     `packages/contract/src/identity.ts`, instead of spelling the name. For the tool at hand,
     the run is safe to finish by hand once the template fix is filed: the tree was clean
     before the run, so `git diff` shows the rename and nothing else.

6. **Check that a second run changes nothing.** Commit first, because the script refuses a
   dirty tree.

   ```bash
   git add -A
   git commit -m "chore: instantiate as examplenotes"
   pnpm instantiate examplenotes --name "Example Notes" --domain examplenotes.example.com
   git status --porcelain
   ```

   The run prints `nothing to change: the tree already carries this identity` and
   `git status --porcelain` prints nothing.

7. **Run the gate.**

   ```bash
   pnpm turbo lint typecheck test build
   pnpm format:check
   pnpm --filter @app/server drift:check
   node scripts/check-chassis-copies.mjs
   ```

   The last command proves the run left `packages/chassis-*` alone. Those folders are copies of
   the chassis source, held byte for byte, and the script never writes them.

8. **Set what the script cannot derive.** The API key prefix is three letters of the tool's
   own. It lives in the identity definition, `packages/contract/src/identity.ts`, field
   `apiKeyPrefix`. Change it there, before the first key is minted: a key keeps the prefix it
   was minted with.

9. **Push.** Add the remote of the repository an org owner created (`antasphere/examplenotes`, default
   branch `prod`, working branch `dev`) and push `dev`.

10. **Know what the tool already carries.** The chassis gives the new tool its projects (a subgroup of
    the workspace with members and roles: the tables, the `/projects` routes, the `projects` CLI group,
    the nine MCP tools, the dashboard's Projects section), and the placeholder resource `items` shows how
    a resource of the tool's own is linked to them. Replacing `items` with the tool's resource is the
    `add-resource` skill; its step 9 is the project link.

## What the script never writes

The table `NEVER` at the top of the script, with the reason beside each row: the chassis copies,
`chassis-source.json`, the lockfile (pnpm writes it), applied migrations, `LESSONS.md` and
`TEMPLATE-FEEDBACK.md` (the record of what happened upstream, by name), the script itself, and
this plugin. The closing check skips exactly those rows and nothing else.

## When the run refuses to start

A refusal exits 2 and writes nothing. (Exit 1 is step 5's: the rename ran and the old name
still stands somewhere.) Through `pnpm`, the message is followed by pnpm's own `ELIFECYCLE`
line.

| Message                                            | Cause and what to do                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `the working tree is not clean`                    | Uncommitted or untracked files. Commit or remove them. The diff of the run must be the rename alone.                   |
| `"<x>" is not a slug`                              | A capital, a hyphen, a leading digit, or fewer than 3 characters. Pick one plain word.                                 |
| `"<x>" already stands on N line(s) of this tree`   | The tree already uses the word (sample data, a comment). Pick a word it does not use. Never edit the lines to free it. |
| `--domain is a lower-case DNS hostname`            | A scheme, a port, a path or a capital in the value.                                                                    |
| `--cli-package is an npm package name`             | Not `@scope/name` or `name` in lower case.                                                                             |
| `"<x>" is a word the code uses for something else` | The slug is reserved. Pick a name only this tool carries.                                                              |
| `--name is one line of plain text`                 | The display name holds a quote, a backslash, an angle bracket or a line break.                                         |
| `cannot read the current identity`                 | `package.json` has no `name`, or `docs/nav.yml` no `product:` line. See `IDENTITY_SOURCES` in the script.              |

## Renaming a tool later

The same command renames a tool already made: the script reads the current name from the tree
and the domain and the CLI package from `.instantiate.json`. The new name obeys the same law
(a word the tree does not use), so a rename is as safe as a first run, and a rename back
restores the tree byte for byte.

The record knows whether the domain and the CLI package were CHOSEN (`--domain`,
`--cli-package`) or derived from the slug. A derived value follows the new slug. A chosen one
stays: a domain is final, grants derive from it. When a chosen domain holds the old slug, the
run says so in a `note:` line and the closing check does not count it; pass `--domain` to
change it. The same names with another `--domain` is a run of its own, which moves the domain
and nothing else.

Never edit `.instantiate.json` by hand. The script holds it to the grammar of the flags and
refuses a record it cannot read, naming the file: restore it from git.

Everything declared outside the repository (the hub registry entry, the fleet environment, the
docs sync, the npm package) keeps the old name until a person changes it there: see
`docs/getting-started/make-a-tool.md` in the template.
