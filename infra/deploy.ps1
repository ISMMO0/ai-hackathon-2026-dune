[CmdletBinding()]
param(
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'

$subscriptionId = 'a6ba4700-4392-410f-945f-e00e51a4e7b9'
$resourceGroup = 'rg_hackathon_antasphere01'
$projectName = 'skillforge'
$expectedLocation = 'swedencentral'
$scriptDirectory = Split-Path -Parent $PSCommandPath
$templateFile = Join-Path $scriptDirectory 'main.bicep'
$exampleParametersFile = Join-Path $scriptDirectory 'main.bicepparam'
$parametersFile = Join-Path $scriptDirectory 'main.local.bicepparam'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
  throw 'Azure CLI is required. Install it, then run az login.'
}

az account set --subscription $subscriptionId
if ($LASTEXITCODE -ne 0) {
  throw "Unable to select subscription $subscriptionId. Run az login and verify access."
}

$resourceGroupLocation = az group show --name $resourceGroup --query location -o tsv
if ($LASTEXITCODE -ne 0) {
  throw "Resource group $resourceGroup was not found in subscription $subscriptionId."
}
if ($resourceGroupLocation -ne $expectedLocation) {
  throw "Resource group $resourceGroup is in $resourceGroupLocation; this deployment requires $expectedLocation."
}

if (-not (Test-Path $parametersFile)) {
  Copy-Item $exampleParametersFile $parametersFile
  Write-Host "Created $parametersFile." -ForegroundColor Yellow
  Write-Host 'The first deployment keeps assignLlmRole = false until Azure OpenAI exists.' -ForegroundColor Yellow
}

az bicep build --file $templateFile
if ($LASTEXITCODE -ne 0) {
  throw 'Bicep validation failed. Deployment stopped.'
}

Write-Host "Running what-if for $resourceGroup..." -ForegroundColor Cyan
az deployment group what-if `
  --resource-group $resourceGroup `
  --template-file $templateFile `
  --parameters $parametersFile projectName=$projectName
if ($LASTEXITCODE -ne 0) {
  throw 'What-if failed. Deployment stopped.'
}

if (-not $Yes) {
  $answer = Read-Host 'Apply these changes? Type DEPLOY to continue'
  if ($answer -cne 'DEPLOY') {
    Write-Host 'Deployment cancelled.' -ForegroundColor Yellow
    exit 0
  }
}

$deploymentName = "skillforge-infra-$(Get-Date -Format 'yyyyMMddHHmmss')"
Write-Host "Deploying $deploymentName..." -ForegroundColor Cyan
az deployment group create `
  --resource-group $resourceGroup `
  --name $deploymentName `
  --template-file $templateFile `
  --parameters $parametersFile projectName=$projectName
if ($LASTEXITCODE -ne 0) {
  throw 'Deployment failed.'
}

Write-Host 'Deployment completed.' -ForegroundColor Green
Write-Host "Function App: fa-$projectName-sc01" -ForegroundColor Green
