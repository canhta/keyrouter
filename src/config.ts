// src/config.ts — Load + hot-reload router.json
//
// Atomic hot-reload:
//   1. fs.watch fires on any write to router.json
//   2. JSON.parse in try/catch guards against partial writes
//   3. ModelRegistry.swap() atomically replaces the config ref
//
// Error on startup:
//   Missing router.json → print instructions + exit 1
//   Invalid JSON → print error + exit 1

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RouterConfig } from './types.ts'
import type { ModelRegistry } from './registry/index.ts'

const CONFIG_PATH = path.join(process.cwd(), 'router.json')

export function loadConfig(): RouterConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`
[keyrouter] ERROR: router.json not found.

Create a router.json file in the current directory. Example:

  cp router.example.json router.json
  # then edit router.json with your provider credentials

`)
    process.exit(1)
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
    return JSON.parse(raw) as RouterConfig
  } catch (err) {
    console.error(`[keyrouter] ERROR: router.json is invalid JSON: ${err}`)
    process.exit(1)
  }
}

export function watchConfig(registry: ModelRegistry): void {
  fs.watch(CONFIG_PATH, () => {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
      const config = JSON.parse(raw) as RouterConfig  // may throw on partial write
      registry.swap(config)
      console.log('[keyrouter] config reloaded')
    } catch {
      // partial write — next fs.watch event will catch the complete file
    }
  })
}
