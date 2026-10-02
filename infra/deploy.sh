#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <existing-resource-group> [parameters-file]" >&2
  exit 2
fi

resource_group="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
params_file="${2:-${script_dir}/main.bicepparam}"

echo "Running what-if against existing resource group: ${resource_group}"
az deployment group what-if \
  --resource-group "${resource_group}" \
  --template-file "${script_dir}/main.bicep" \
  --parameters "${params_file}"

echo "Deploying to existing resource group: ${resource_group}"
az deployment group create \
  --resource-group "${resource_group}" \
  --name "skillforge-infra-$(date +%Y%m%d%H%M%S)" \
  --template-file "${script_dir}/main.bicep" \
  --parameters "${params_file}"
