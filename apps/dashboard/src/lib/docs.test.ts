import { describe, expect, it } from 'vitest';
import { DOCS_URL, agentPrompt, docsPage } from './docs';

describe('the docs address and the agent prompt', () => {
  it('points every reader at the public docs site, never at the repository', () => {
    // The literal on purpose: the section is the tool's slug, and an instantiated tool re-pins it.
    expect(DOCS_URL).toBe('https://docs.antasphere.com/starter');
    expect(docsPage('getting-started/connect-an-agent')).toBe(`${DOCS_URL}/getting-started/connect-an-agent`);
    expect(docsPage('/agents/cli')).toBe(`${DOCS_URL}/agents/cli`);
  });

  it('names THIS instance in the prompt: its MCP endpoint, its CLI login and the page to read first', () => {
    const prompt = agentPrompt('https://tool.example.com');
    expect(prompt).toContain('You are working with Hackathon Starter');
    expect(prompt).toContain('My instance: https://tool.example.com');
    expect(prompt).toContain('claude mcp add --transport http starter https://tool.example.com/mcp');
    expect(prompt).toContain('npm i -g @antasphere/starter');
    expect(prompt).toContain('starter login --api-url https://tool.example.com --api-key ytk_...');
    expect(prompt).toContain('with items:write');
    expect(prompt).toContain(docsPage('getting-started/connect-an-agent'));
    expect(prompt).toContain(docsPage('agents/mcp-connector'));
    // the prompt never carries a credential of its own: the key is the person's to paste
    expect(prompt).not.toMatch(/ytk_[A-Za-z0-9]{8,}/);
    expect(prompt).not.toContain('github.com');
  });
});
