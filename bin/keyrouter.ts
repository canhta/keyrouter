#!/usr/bin/env bun
// bin/keyrouter.ts — CLI entry point
//
// Usage:
//   keyrouter              → start the proxy server
//   keyrouter auth <provider>  → run OAuth device flow for a provider

const [cmd, ...args] = Bun.argv.slice(2)

if (cmd === 'auth') {
  const { runAuthFlow } = await import('../src/cli/auth.ts')
  await runAuthFlow(args[0])
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  printHelp()
} else if (cmd === undefined || cmd === 'start') {
  const { startServer } = await import('../src/index.ts')
  await startServer()
} else {
  console.error(`[keyrouter] Unknown command: ${cmd}`)
  printHelp()
  process.exit(1)
}

function printHelp(): void {
  console.log(`
keyrouter — Local AI proxy router

Usage:
  keyrouter                   Start the proxy server
  keyrouter auth <provider>   Authenticate with a provider (device flow)
  keyrouter help              Show this help

Providers:
  copilot    GitHub Copilot (OAuth device flow)
  codex      OpenAI Codex (PKCE flow)

Example:
  keyrouter auth copilot
  keyrouter
`)
}
