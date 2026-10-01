# Hostinger distribution

`docker-compose.yml` is a standalone template: no checkout, build context,
host scripts, or companion config files. `STARTER_DOMAIN` is its only
required input. `index.html` contains the deployment button and template URL.
User instructions live in `docs/self-hosting/hostinger.md`.

## Acceptance criteria

- A dedicated VPS with DNS configured can start the stack from the public URL.
- Only Caddy publishes ports, with HTTPS and HTTP-to-HTTPS redirects.
- First boot generates separate database and authentication secrets and a
  setup token. Redeploying preserves credentials, users, and uploaded files.
- Missing or malformed hostnames fail before initialization; damaged stored
  credentials fail without replacement.
- The owner can claim the instance using the app log token and sign in.
- Agent connection (API keys, the MCP endpoint) and email configuration are optional.
- The app image is version-pinned; upgrades remain manual.

## Publication

Never publish the repository root as a Pages artifact. The `hostinger-pages.yml`
workflow publishes exactly `deploy/index.html` (the root) and this folder's
`index.html` + `docker-compose.yml` under `/hostinger/` on the Pages site, served on
the product's deploy domain `https://deploy.starter.antasphere.com/` (a CNAME to
`antasphere.github.io`; the github.io address redirects there). The domain is
product-scoped and the host is the path — a second host (Hetzner, Coolify, …) is a
sibling folder `deploy/<host>/` staged the same way, never a second domain. The
compose URL customers paste is `https://deploy.starter.antasphere.com/hostinger/docker-compose.yml`;
the deploy button and the guide both use it, never a raw GitHub URL.

There is no pin yet: the tool has published no release, and the app image says so with the one
reference allowed without a digest, `:unreleased`. `scripts/hostinger-smoke.mjs` refuses to run on
it without `HOSTINGER_TEST_IMAGE`, and CI's `hostinger` job reads it and skips the rehearsal on the
published image with a notice. The first release replaces `:unreleased`, on the `init` and `app`
services, with `<version>@sha256:<digest>`. From then on `scripts/hostinger-template.test.mjs`
refuses anything but a digest pin, and CI rehearses the published image on every run. The pin names
a released version on purpose: the image reports that version on `GET /instance`, so a customer and
a support session agree on which build is running. The
companion images (`pgvector/pgvector:0.8.6-pg17`, `caddy:2.11.4-alpine`) are pinned on IMMUTABLE version tags with their digests — never on a floating tag like `caddy:2-alpine`: `docker manifest inspect tag@digest` resolves the tag first, so the Pages gate fails the day upstream moves it (2026-09-18). The gate then inspects exactly what customers will pull.

Before its first successful run:

1. Enable GitHub Pages with GitHub Actions as its build source (free once the
   repository is public). Only the two published files leave the repository.
2. Make the GHCR `antasphere/starter` package publicly readable. Check
   anonymous manifest access, not just access while logged in. The Pages
   workflow refuses to publish if any template image is inaccessible anonymously.
3. Merge the template and guide to `prod`, let the docs sync publish the
   guide, and run **Publish Hostinger deployment**. Check the public YAML URL
   returns the file without authentication, then import it in hPanel.
4. Verify a fresh dedicated Hostinger VPS using the guide, including a public
   certificate, owner setup, sign-in, and recreation with retained volumes.

GitHub Pages publication does not submit Hackathon Starter to the Hostinger catalog.
Establish Hostinger's submission process separately; supply the tested public
template, guide, app description, and image details when requested.

## Verification

```bash
node --test scripts/hostinger-template.test.mjs
docker build -t starter:hostinger-test .
HOSTINGER_TEST_IMAGE=starter:hostinger-test node scripts/hostinger-smoke.mjs
```

The smoke test uses an isolated Compose project, local CA certificates, and
loopback-only random ports. It exercises the production template with only
test transport and image overrides. It does not contact an ACME authority or
prove Hostinger's UI accepts the template. CI runs this rehearsal on PRs.

Before changing the pinned image, run the smoke against that exact published
image too, and update both the template and deployment page. Container UIDs,
the `/data` volume, `tini`, Node, and the server entrypoint are part of the
template's image contract.

## Verified on a real Hostinger VPS

The run below was made upstream, with the product this template was cut from, on this same Compose file.
A tool repeats it once with its own image before it points customers at the page.

2026-09-18, KVM 1 (1 vCPU, 4 GB, Germany), Plain OS → Ubuntu 24.04, Docker Manager:
Compose from URL → Environment, the domain variable set to the instance's hostname → Deploy.
Let's Encrypt certificate obtained ~30 s after Deploy, `init` 0 → `db` healthy → `app`
healthy → `caddy` up, HTTP 308 → HTTPS, wizard claimed with the token from the app log,
owner signed in, `POST /api/v1/setup` → 410 afterwards. Two things the run corrected in
the template and the guide: hPanel runs the file with no environment (a `${VAR:?}`
render refusal leaves no project), and the deploy button does not carry the template
into a new VPS.

## Upgrading a Hostinger instance

Three rules from the upgrade of the upstream product's reference instance (Slideless, 21 September 2026,
three releases in one step), which a tool keeps:

- Take the published template whole (download it from the deploy URL), never a hand-edited pin: the
  instance then runs exactly what a customer's redeploy installs, and the fixes made to the file since
  the last deploy come with it.
- Probe the setup closure with the real body shape: a `POST /api/v1/setup` that the schema refuses
  answers 400 first, and a 400 proves nothing about the closure. A well-formed body answers 410
  `already_setup` and creates no user.
- A VPS snapshot is the only true rollback, since migrations are forward-only. A `pg_dumpall` and a
  copy of the app's data and credentials volumes are a partial net, not a rollback.

The steps for an operator are in the public guide, `docs/self-hosting/hostinger.md`, under "Upgrading".
