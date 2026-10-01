---
name: deploy-on-fleet
description: Put a tool made from this template on the Antasphere fleet (GCP Cloud Run, driven by the repository antasphere/infra). Invoke it when the user says "deploy this tool on the fleet", "put examplenotes on Cloud Run", "write the infra env for this tool", "set up the unattended roll", or asks why a prod push did not reach the live instance. It walks the whole path in order. The env directory envs/<tool>/ in infra, deploy.env and its nine keys, the two lines of deploy.yml, the three-move first apply by hand, the image mirror and pin, the GitHub clicks, DNS, the setup wizard, the proof of the unattended roll, and the rollback command.
---

# Deploy a tool on the Antasphere fleet

This skill records what was done for Slideless, the first tool deployed this way.
Do not improvise a step. If a step here does not match what you see, stop and ask.

The examples use invented names: slug `examplenotes`, display name `Example Notes`, domain `examplenotes.example.com`, GCP project `antasphere-examplenotes`, tool repository `antasphere/examplenotes`. Replace them everywhere. The slug is the env directory name, the Cloud Run service name, the image name and the dispatch type prefix. They must all be the same string.

## How the roll works

1. A push to the `prod` branch of `antasphere/examplenotes` starts `.github/workflows/release.yml`.
2. That workflow runs the version guard, an e2e smoke and a Trivy HIGH/CRITICAL scan. Then it builds the image and pushes it to `ghcr.io/antasphere/examplenotes`.
3. Its last step sends a `repository_dispatch` of type `examplenotes-published` to `antasphere/infra`. The payload carries the sha, the version, the GHCR digest and the commit subject.
4. `.github/workflows/deploy.yml` in `antasphere/infra` does the roll:
   - It copies the image by digest into `europe-west1-docker.pkg.dev/antasphere-examplenotes/images/examplenotes:prod-<short sha>`.
   - It reads the Artifact Registry digest back. The registry rewrites the index, so this digest differs from the GHCR one.
   - It pins `@sha256:` on the `image` line of `envs/examplenotes/main.tf`.
   - It plans, applies, and probes `/readyz` and `/api/v1/instance`.
   - It commits `deploy(prod): examplenotes ...` to `main`.
5. On a failed probe, the workflow pins the previous digest again and applies again. It commits nothing.

The roll lives in `antasphere/infra` and not in the tool repository. A deploy workflow in the tool repository would publish the project ids, the registry paths and the service names.

The three scripts in `scripts/` of `antasphere/infra` are generic. Nothing in them is per tool.

| Script                 | What it refuses                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/pin-image.sh` | A digest that is not `sha256:` plus 64 hex characters. A `main.tf` that does not hold exactly one pinned `.../examplenotes@sha256:...` line.                                                                 |
| `scripts/plan-gate.sh` | Any plan that is not exactly one in-place update of the Cloud Run service. A plan with no change passes as `noop`. A missing plan file is a refusal.                                                         |
| `scripts/probe.sh`     | A latest ready revision that does not serve 100 % of the traffic. A revision whose digest is not in the pinned index. `/readyz` not answering 200. `/api/v1/instance` serving another version than expected. |

## Before you start

- [ ] The slug, the display name and the FINAL domain are fixed. Changing the domain later kills the hub grants and the redirect URIs.
- [ ] The repository `antasphere/examplenotes` exists with the branches `prod` (default) and `dev`. An org owner creates it.
- [ ] The hub env is applied and live. The hub is the identity provider.
- [ ] A human with these rights is available: a GCP org member with project-create and billing-link rights, an org owner of the GitHub org `antasphere`, the holder of the GoDaddy DNS account.
- [ ] That human has `gcloud`, `tofu` (OpenTofu, `terraform` is not installed), `docker` with `buildx`, and `gh` on a laptop.
- [ ] You have a checkout of `antasphere/infra` (single branch `main`).

## Steps

### 1. Re-enable the release workflow (tool repository)

File: `.github/workflows/release.yml` in `antasphere/examplenotes`.

The template publishes, deploys and dispatches nothing. In every publishing workflow the trigger is `on: workflow_dispatch` alone, and every job carries `if: ${{ false }} # disabled in the template`, so a manual run does nothing either. The original trigger is kept as a comment block right above the `on:` line, and each file's header says what it does when enabled.

To re-enable `release.yml`, on the `dev` branch of the tool repository, as one commit that move 2 of step 4 then promotes:

1. Replace the line `on: workflow_dispatch` with the commented `on:` block above it (`push` on `branches: [prod]` with its `paths-ignore`, and `tags: ['v*']`).
2. Remove the four job guards. Find them with `grep -n 'disabled in the template' .github/workflows/release.yml`. Three are plain `if: ${{ false }}` lines: delete them. The fourth, on the publish job, reads `if: ${{ false }} # disabled in the template; was: vars.RELEASE_ENABLED == 'true'`: put the original condition back, `if: vars.RELEASE_ENABLED == 'true'`.
3. Check the dispatch step at the end of the file. The `event_type` string must read `examplenotes-published`, in the `jq` expression and in the summary line. `pnpm instantiate` writes it. It must equal the type you add to infra in step 3.

The publish job runs only when the repository variable `RELEASE_ENABLED` equals `true` (step 2). Until then the smoke and the scan still run on every push, and nothing is published.

The other publishers are disabled the same way and are not needed for the roll. Re-enable each one when its step comes: `docs-notify.yml` and `docs-notify-release.yml` with the public docs, `publish-cli.yml` with the CLI on npm, `hostinger-pages.yml` with the self-hosting page. The count of guards per file is what `grep -c 'disabled in the template'` prints. `hostinger-pages.yml` also carries one guard with a `was:` condition to put back, like the publish job here.

Also read `scripts/release.mjs` in the tool repository. The commit subject it writes is `chore(release): <name> X.Y.Z`. `pnpm instantiate` writes the tool's slug there and in the dispatch step. If either still shows another name, the rename did not run on this repository: run the skill `instantiate` first, do not edit the two places by hand.

### 2. Set the secrets and the variable (GitHub settings, by hand, org owner)

On `antasphere/examplenotes`:

- Secret `FLEET_DISPATCH_APP_ID`. It is the id of the existing GitHub App `antasphere-fleet-dispatch`, shown on the app page.
- Secret `FLEET_DISPATCH_APP_KEY`. Generate a NEW private key on the app page (github.com/organizations/antasphere/settings/apps/antasphere-fleet-dispatch). The old `.pem` is not kept.
- Variable `RELEASE_ENABLED` with the value `true`: `gh variable set RELEASE_ENABLED -R antasphere/examplenotes --body true`, or Settings, Secrets and variables, Actions, Variables.

```bash
gh secret set FLEET_DISPATCH_APP_ID  -R antasphere/examplenotes --body <app id>
gh secret set FLEET_DISPATCH_APP_KEY -R antasphere/examplenotes < <path to the downloaded .pem>
```

The app stays installed on `infra` ONLY. Do not add an installation.

The infra repository secrets `TF_VAR_ORG_ID` and `TF_VAR_BILLING_ACCOUNT` already exist. They serve every env. Add nothing there.

### 3. Write the env directory (antasphere/infra)

Copy `envs/slideless/` to `envs/examplenotes/`. Do not copy `.terraform/` or `terraform.tfvars`. Then edit each file.

**`envs/examplenotes/main.tf`**: the file opens with a `terraform {}` block and a `provider "google"` block. Keep both, with ONE edit inside the first: the `backend "gcs"` block sits INSIDE `terraform {}`, and its `prefix` must become `envs/examplenotes`. A copied file that keeps the first tool's prefix works on the first tool's state, and nothing downstream catches it before an apply. Then the file declares, in this order:

- (Already done above: `backend "gcs" { bucket = "antasphere-tfstate"  prefix = "envs/examplenotes" }`, inside `terraform {}`.)
- The project: `locals { project_id = "antasphere-examplenotes" }` and `resource "google_project" "project" { name = "Antasphere Example Notes" ... }`.
- The `instance` module:

  ```hcl
  module "instance" {
    source = "../../modules/instance"
    name   = "examplenotes"
    image  = "europe-west1-docker.pkg.dev/${local.project_id}/images/examplenotes@sha256:<digest>"
    domain = "examplenotes.example.com"
    db_name           = "examplenotes"
    redis_enabled     = true
    bucket_enabled    = <true if the tool stores blobs>
    backup_start_time = "<HH:MM UTC, staggered: the hub has 02:00, Slideless 03:00>"
    ...
  }
  ```

  Keep `project_id`, `project_number` and `region` as in the copied file. They are references (`google_project.project.number` and the like), not literal values of the first tool.

- The `env = {}` block inside the module. It holds the federation env, two plain strings known from the start: `HUB_ISSUER_URL = "https://account.antasphere.com"` and `HUB_CLIENT_ID = "tool-examplenotes-cloud"`. Write them now, so the first apply carries them; the sister skill `federate-to-hub` explains them and later puts the real client secret in place. The copied file also sets `EMAIL_DRIVER = "brevo"` and an `EMAIL_FROM` with the first tool's name. If the tool sends mail, keep both and write `EMAIL_FROM = "Example Notes <noreply@mail.antasphere.com>"`. If it does not, delete both lines and the `BREVO_API_KEY` entry below.
- The `glue_secrets = {}` block inside the module. Each entry is a Secret Manager container that Terraform seeds with a placeholder version:

  ```hcl
  HUB_CLIENT_SECRET = {
    name        = "examplenotes-hub-client-secret"
    placeholder = "<16 or more characters, valid at boot>"
  }
  ```

  The copied file holds a second entry, `BREVO_API_KEY`, named after the first tool. If the tool sends mail, rename it `examplenotes-brevo-api-key` and keep its placeholder `xkeysib-placeholder`. Do NOT copy a `HUB_SERVICE_KEY` entry. The infra README still lists `slideless-hub-service-key`. It is retired.

- The `deployer` module:

  ```hcl
  module "deployer" {
    source = "../../modules/github-deployer"
    project_id              = google_project.project.project_id
    name                    = "examplenotes"
    runtime_service_account = module.instance.service_account
    state_prefix            = "envs/examplenotes"
  }
  ```

  It creates the Workload Identity pool and provider that trust only `antasphere/infra`, the service account `examplenotes-deployer`, its roles, and the state access limited to the prefix `envs/examplenotes/`.

- Three outputs: `run_url`, `deployer`, `dns_records`. Keep them as copied.

**`envs/examplenotes/variables.tf`** and **`envs/examplenotes/terraform.tfvars.example`**: copy them unchanged. They declare `org_id` and `billing_account`, the same for every env.

**`envs/examplenotes/.terraform.lock.hcl`**: generate it for both platforms and commit it, alone: `main.tf` is not committed yet (see the end of this step). `tofu init` reads the GCS state bucket, so this needs the human's GCP login (`gcloud auth application-default login`, the first command of step 4). Ask the human to log in now, or leave the lock to the human as the opening of step 4.

```bash
cd envs/examplenotes
tofu init
tofu providers lock -platform=linux_amd64 -platform=darwin_arm64
```

**`.github/workflows/deploy.yml`** in `antasphere/infra`: edit two lines. The steps never change.

```yaml
types: [slideless-published, hub-published, examplenotes-published]
...
options: [slideless, hub, examplenotes]
```

The workflow derives the product as the dispatch type minus `-published`. That product must equal the directory name `envs/examplenotes`.

Commit the two lines of `deploy.yml` to `main` now. They must be on `main` before the first `prod` push of the tool. Do NOT commit `envs/examplenotes/main.tf` yet: its `image` line still holds the digest of the copied file, which belongs to another tool. Move 1 of step 4 never reads that line (it targets the project and the registry only), move 2 writes the real digest, and step 5 commits the file.

### 4. First apply, in three moves (GCP, by hand, from a laptop)

Who: a GCP org member with project-create and billing-link rights.

```bash
gcloud auth application-default login
cp envs/examplenotes/terraform.tfvars.example envs/examplenotes/terraform.tfvars   # then fill it in
```

`terraform.tfvars` is gitignored. The example file names the `gcloud` command that prints each value. If the application-default credentials expire, this override works: `export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)` before `tofu init`, `plan`, `apply`.

**Move 1. The project and the Artifact Registry.** The image must exist before the service can start.

```bash
cd envs/examplenotes
tofu init
tofu apply -target=google_project.project \
           -target=module.instance.google_artifact_registry_repository.images
```

**Move 2. Publish a first image and mirror it by hand.**

In the tool repository, on a clean `dev`:

```bash
pnpm release <patch, minor or major> --push
git push origin origin/dev:refs/heads/prod
gh run list -R antasphere/examplenotes -w release.yml --branch prod -L 1
```

The kind of bump is the human's call, never derived. The run takes about 20 minutes. `pnpm release --push` also pushes a `v*` tag, which starts a second run of the same workflow: the `--branch prod` run is the one that dispatches. Its dispatch succeeds and `release.yml` ends green; the run it starts in `antasphere/infra` is the one that fails at this point. That is expected: `envs/examplenotes/deploy.env` does not exist yet, so the step `Resolve the instance` of `deploy.yml` stops with `no envs/examplenotes/deploy.env — is 'examplenotes' an instance of this fleet?`. The published tag is `sha-<short sha>`.

The package is private, so read it with a token that has the packages scope. A human runs `gh auth refresh -h github.com -s read:packages` (a device-code flow). Do not let `docker login` store the token in the macOS keychain: later GHCR reads then hang. Use a throwaway Docker config directory instead (`export DOCKER_CONFIG=$(mktemp -d)`, with `~/.docker/cli-plugins` linked into it). The exact lines are in `README.md` of `antasphere/infra`, section "Break-glass: the roll by hand", item 3. Then copy the image: That snippet spells one person's GitHub login inside its auth line: put your own. It also leans on the `gcloud` credential helper for the Artifact Registry side (`gcloud auth configure-docker europe-west1-docker.pkg.dev`).

```bash
docker buildx imagetools create \
  --tag europe-west1-docker.pkg.dev/antasphere-examplenotes/images/examplenotes:prod-<short sha> \
  ghcr.io/antasphere/examplenotes:sha-<short sha>
```

Read the digest back from Artifact Registry. Do not use the GHCR digest.

```bash
gcloud artifacts docker images describe \
  europe-west1-docker.pkg.dev/antasphere-examplenotes/images/examplenotes:prod-<short sha> \
  --format 'value(image_summary.digest)'
```

Check that the value is not empty. Write it on the `image` line of `envs/examplenotes/main.tf` as `...images/examplenotes@sha256:<digest>`. Pin the digest, never the tag.

**Move 3. Everything else.**

```bash
tofu apply
tofu output deployer
tofu output dns_records
```

Service and domain-mapping creates block for a long time. Do not interrupt the apply. An interrupted apply leaves the resource orphaned and the next apply answers 409.

### 5. Write deploy.env (antasphere/infra)

File: `envs/examplenotes/deploy.env`. Plain `KEY=value` lines, no quotes, no expansion. All nine keys are required. The workflow refuses a file that lacks one.

```
PRODUCT_REPO=antasphere/examplenotes
PROJECT=antasphere-examplenotes
REGION=europe-west1
SERVICE=examplenotes
SERVICE_ADDRESS=module.instance.google_cloud_run_v2_service.app
AR_IMAGE=europe-west1-docker.pkg.dev/antasphere-examplenotes/images/examplenotes
BASE_URL=https://examplenotes.example.com
WIF_PROVIDER=projects/<project number>/locations/global/workloadIdentityPools/github/providers/github
DEPLOYER_SA=examplenotes-deployer@antasphere-examplenotes.iam.gserviceaccount.com
```

`tofu output deployer` prints the last two values. Commit `main.tf` (with the pinned digest) and `deploy.env` to `main`.

### 6. Grant infra read access on the package (GitHub settings, by hand, org owner)

Page: github.com/orgs/antasphere/packages/container/examplenotes/settings. Manage Actions access, Add repository, `infra`, role Read.

This click is possible only AFTER the first image publish, because the package does not exist before. There is no API for it. Without it, the mirror step of `deploy.yml` refuses with the message "is it published, and does the package grant this repository read access?".

Package visibility: leave it private unless the self-hosting page or the fair-code distribution is wanted. To make it public, use the Danger Zone of the same page. `hostinger-pages.yml` in the tool repository needs a public package.

### 7. DNS (GoDaddy, by hand, the holder of the DNS account)

Create the record or records that `tofu output dns_records` printed for `examplenotes.example.com`. Then wait for the Google certificate. Google issues it once the record resolves, typically in 15 to 60 minutes.

Check: `https://examplenotes.example.com/readyz` answers 200. Never probe `/healthz` on Cloud Run. Google's front end reserves that path.

### 8. Federation

The hub registry entry and the tool's federation env and client secret come here: after DNS, before the setup wizard. The sister skill `federate-to-hub` holds them.

### 9. Run the setup wizard once (the operator, by hand)

Run it ONLY when the final domain serves. Open `https://examplenotes.example.com`. The wizard asks for the setup token. Terraform generated it in the secret `examplenotes-setup-token`:

```bash
gcloud secrets versions access latest --secret=examplenotes-setup-token --project=antasphere-examplenotes
```

Do not paste the value in a chat or a file.

## Proof

Prove the unattended roll with a real release. In the tool repository, on a clean `dev`:

```bash
pnpm release <patch, minor or major> --push
git push origin origin/dev:refs/heads/prod
gh run list -R antasphere/examplenotes  -w release.yml -L 1     # the publish
gh run list -R antasphere/infra -w deploy.yml  -L 1     # the roll, its summary names the live revision
```

The version must move first. The first job of `release.yml` (`node scripts/release.mjs guard`) refuses a push whose package version already carries a v-tag on another commit.

The proof is complete when all of this is true, with no human step after the push:

- A commit `deploy(prod): examplenotes ...` is on `main` of `antasphere/infra`, made by the workflow. It carries the sha, both digests, the previous digest, the revision and the run link.
- `https://examplenotes.example.com/readyz` answers 200.
- `https://examplenotes.example.com/api/v1/instance` serves the version that the push carried.

A promotion that touches only `docs/`, `deploy/` or the docs and pages publisher workflows is not a release. `release.yml` ignores those paths. No image is built and nothing rolls.

Optional, after the proof: add the tool's row to the "Live today" table of `README.md` in `antasphere/infra`, and write `docs/examplenotes-deploy.html` from `docs/hub-deploy.html` (the short form for a second instance).

## Rollback

```bash
gh workflow run deploy.yml -R antasphere/infra -f product=examplenotes -f sha=<full 40-char sha> -f version=<apps/server version at that sha>
```

`image_digest` is optional. When omitted, the workflow resolves it from the `sha-<short>` tag.

- A rollback reaches back only to the last migration boundary. The database rolls forward, not back. An image older than the database refuses readiness (`database is AHEAD of this image`). The workflow then pins the newer digest again by itself. Traffic never moves.
- To undo a release that ran a migration, roll FORWARD: a revert commit on `dev`, then the normal release and promotion.
- Every release is built twice: once by the v-tag push, once by the `prod` push. The `sha-<short>` tag points at the LAST build. To roll again exactly what a release deployed, pass `-f image_digest=<the Source: digest of its deploy(prod) commit>`.
- To know what is live, read the last `deploy(prod): examplenotes ...` commit on infra `main`.
- If `deploy.yml` itself is broken, use `README.md` in `antasphere/infra`, section "Break-glass: the roll by hand". It uses the same three scripts.

## Traps

- **An env value the image does not know yet crashloops the revision.** `EMAIL_DRIVER` is an enum checked at boot. Roll the image that knows the value first. Apply the env after.
- **The lock must carry both platforms.** Without `linux_amd64` and `darwin_arm64` in `envs/examplenotes/.terraform.lock.hcl`, CI resolves another provider build and the plan gate reads it as a diff.
- **`deploy.yml` refuses any plan that is not one in-place service update.** A new secret container in `glue_secrets` is a create. Apply it by hand first with a targeted apply. Then let the env change ride one service update.
- **The image name in `main.tf` must end with `/images/examplenotes`.** The path is written with `${local.project_id}`, so `pin-image.sh` matches on the image NAME at the end of the path. It demands exactly one such pinned line.
- **The placeholder of a glue secret must pass the app's boot-time env schema.** `HUB_CLIENT_SECRET` needs 16 characters or more. A generic short placeholder crashlooped the first apply. The placeholder version carries `ignore_changes`. To change a placeholder, run an explicit `apply -replace='module.instance.google_secret_manager_secret_version.glue_placeholder["VAR"]'`.
- **Only a `prod` BRANCH push dispatches.** A `v*` tag publishes the semver aliases and nothing else.
- **A new secret version restarts nothing.** Roll the service, then remove the drift:

  ```bash
  gcloud run services update examplenotes --region=europe-west1 --project=antasphere-examplenotes --update-labels=glue-rev=<N>
  tofu apply
  ```

- **Never run `describe`, `sed`, `apply` and `commit` inside one piped group.** An empty digest once travelled to a broken commit on `main`. Run the steps one at a time and check each value.
- **A HIGH finding in any dependency blocks the publish**, even when the code change is unrelated. Bump that dependency alone and promote again.
