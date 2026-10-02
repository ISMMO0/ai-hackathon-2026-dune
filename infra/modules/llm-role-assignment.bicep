targetScope = 'resourceGroup'

param llmResourceName string
param functionPrincipalId string
param functionResourceId string
param roleDefinitionId string

resource llmAccount 'Microsoft.CognitiveServices/accounts@2023-05-01' existing = {
  name: llmResourceName
}

resource llmOpenAIUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(llmAccount.id, functionResourceId, roleDefinitionId)
  scope: llmAccount
  properties: {
    principalId: functionPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleDefinitionId
  }
}
