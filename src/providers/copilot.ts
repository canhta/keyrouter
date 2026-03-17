// src/providers/copilot.ts — GitHub Copilot provider
//
// Copilot requires capability headers on EVERY request, not just Authorization.
// This is why the interface is requestHeaders() not authHeader().
//
// Headers confirmed working from 9router reference implementation.

import type { Credential, ProviderDefinition } from '../types.ts'

export const copilotProvider: ProviderDefinition = {
  id: 'copilot',
  name: 'GitHub Copilot',
  baseUrl: 'https://api.githubcopilot.com',
  requestHeaders(cred: Credential): Record<string, string> {
    return {
      'Authorization': `Bearer ${cred.value}`,
      'Editor-Version': 'Neovim/0.9.5',
      'Editor-Plugin-Version': 'copilot.vim/1.16.0',
      'Copilot-Integration-Id': 'vscode-chat',
      'Content-Type': 'application/json',
    }
  },
}
