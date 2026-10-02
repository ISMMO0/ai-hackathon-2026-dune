using './main.bicep'

param projectName = 'skillforge'
param allowedOrigins = [
  'http://localhost:5173'
]
param azureOpenAiEndpoint = 'https://replace-with-your-llm-account.openai.azure.com/'
param azureOpenAiDeployment = 'replace-with-your-model-deployment-name'
param azureOpenAiApiVersion = '2024-10-21'

// The LLM account may not exist yet. Set assignLlmRole to false for the first deployment.
param llmResourceName = 'replace-with-your-llm-account-name'
param llmResourceGroup = 'replace-with-your-existing-llm-resource-group'
param assignLlmRole = false
