# Azure Function baseline

## Prerequisites

- Azure CLI signed in with `az login`.
- Azure Functions Core Tools v4 (`func`).
- Python 3.13 for local development. The Function App uses Python 3.13 because Azure Functions Core Tools remote builds for Flex Consumption do not yet support Python 3.14.
- An existing resource group and an existing Azure AI Foundry / Azure OpenAI account plus model deployment.

## Infrastructure

The deployment scripts only target an existing resource group; they never create one.

On this Windows machine, use the prefilled PowerShell script:

```powershell
.\infra\deploy.ps1
```

It selects subscription `a6ba4700-4392-410f-945f-e00e51a4e7b9`, validates existing resource group `rg_hackathon_antasphere01` is in `swedencentral`, runs `what-if`, displays it, and requires typing `DEPLOY` before applying changes. On first use it creates the ignored `infra/main.local.bicepparam` from the example. Use `-Yes` only when the displayed `what-if` was already reviewed.

```powershell
.\infra\deploy.ps1 -Yes
```

Edit `infra/main.local.bicepparam` with the Azure OpenAI endpoint, model deployment, and existing LLM resource information. To deploy before the LLM exists, leave `assignLlmRole = false`; set the endpoint and deployment settings later, then redeploy with `assignLlmRole = true`.

`infra/deploy.sh` remains available for Bash environments and requires a resource group argument.

The Function uses Python 3.13. Although Python 3.14 is listed for Flex Consumption, Azure Functions Core Tools remote builds for Flex Consumption do not yet support it; Python 3.13 keeps `func azure functionapp publish --python` operational. Sweden Central is verified by `az functionapp list-flexconsumption-locations` on this machine.

Storage is accessed through the Function system-assigned managed identity. The template assigns `Storage Blob Data Owner` (the host minimum), `Storage Table Data Contributor` for host diagnostics and Durable state, and `Storage Queue Data Contributor` for Durable orchestration queues.

## Publish and test

```bash
cd api
func azure functionapp publish fa-<project>-sc01 --python

az functionapp keys list \
  --resource-group <existing-resource-group> \
  --name fa-<project>-sc01 \
  --query functionKeys.default -o tsv

curl https://fa-<project>-sc01.azurewebsites.net/api/health
curl -i https://fa-<project>-sc01.azurewebsites.net/api/llm-ping
curl -H "x-functions-key: <function-key>" \
  https://fa-<project>-sc01.azurewebsites.net/api/llm-ping
curl -X POST -H "Content-Type: application/json" \
  -H "x-functions-key: <function-key>" \
  -d '{"topic":"Azure Functions","audience":{"role":"developer"},"sources":[]}' \
  https://fa-<project>-sc01.azurewebsites.net/api/generate
```

`POST /api/generate` returns `202` with a `jobId`. Poll `GET /api/generate/{jobId}` with the same Function key until its `status` is `Completed` or `Failed`. The `skill.md` placeholder is returned only after completion. Durable Functions persists this state in the configured Storage account, so the HTTP request does not remain open during a long pipeline.

The Function key stays server-side. No browser call or frontend integration is added in this baseline; add a backend proxy in the existing application before any browser feature invokes `llm-ping` or `generate`.

For local development, copy `local.settings.json.example` to the ignored `local.settings.json`. `DefaultAzureCredential` uses the current `az login` identity. No LLM API key is used.

## Validation checklist

- Repeat `./deploy.sh <existing-resource-group>`: the second `what-if` should contain no unexpected changes.
- `health` returns `200` without a key.
- `llm-ping` returns `401` without a key. With the key it returns `200` after the `Cognitive Services OpenAI User` role assignment has propagated; check that assignment first for LLM `401` or `403`.
- `generate` returns `200` for the documented JSON and `400` for malformed or invalid input.
