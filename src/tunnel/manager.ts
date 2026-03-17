// src/tunnel/manager.ts — TunnelManager: cloudflared process lifecycle
//
// TunnelManager process lifecycle:
//   start() → Bun.spawn(['cloudflared', 'tunnel', '--url', 'http://localhost:PORT'])
//     └─ parse stdout/stderr for 'https://.*trycloudflare.com' URL (30s timeout)
//        ├─ found  → store url, resolve with url
//        └─ timeout → kill process, reject with TunnelStartError
//
//   stop() → subprocess.kill() → url = null
//
//   subprocess exits unexpectedly → url = null, onStop callback fired

import type { DashboardEventBus } from '../events/bus.ts'

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

export class TunnelManager {
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private _url: string | null = null

  constructor(
    private port: number,
    private bus: DashboardEventBus
  ) {}

  get url(): string | null {
    return this._url
  }

  get running(): boolean {
    return this.proc !== null
  }

  async start(): Promise<string> {
    if (this.proc) throw new TunnelAlreadyRunningError()

    // Check cloudflared is installed
    const which = Bun.spawnSync(['which', 'cloudflared'])
    if (which.exitCode !== 0) {
      throw new CloudflaredNotFoundError()
    }

    const proc = Bun.spawn(
      ['cloudflared', 'tunnel', '--url', `http://localhost:${this.port}`],
      { stderr: 'pipe', stdout: 'pipe' }
    )

    this.proc = proc

    // Parse URL from stdout/stderr with 30s timeout
    const url = await this.parseUrl(proc)
    this._url = url
    this.bus.publish({ type: 'tunnel', data: { url } })

    // Watch for unexpected exit
    proc.exited.then(() => {
      if (this.proc === proc) {
        this.proc = null
        this._url = null
        this.bus.publish({ type: 'tunnel', data: { url: null } })
      }
    })

    return url
  }

  stop(): void {
    if (!this.proc) return
    this.proc.kill()
    this.proc = null
    this._url = null
    this.bus.publish({ type: 'tunnel', data: { url: null } })
  }

  private async parseUrl(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
    const deadline = Date.now() + 30_000
    const decoder = new TextDecoder()

    // Read from both stdout and stderr (cloudflared logs to stderr)
    const streams = [proc.stdout, proc.stderr].filter(Boolean)

    return new Promise((resolve, reject) => {
      let found = false

      const checkStream = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader()
        try {
          while (Date.now() < deadline) {
            const { done, value } = await reader.read()
            if (done) break
            const text = decoder.decode(value)
            const match = text.match(URL_PATTERN)
            if (match && !found) {
              found = true
              resolve(match[0])
              return
            }
          }
        } finally {
          reader.releaseLock()
        }
        if (!found) reject(new TunnelStartError())
      }

      // Set overall timeout
      const timer = setTimeout(() => {
        if (!found) {
          proc.kill()
          reject(new TunnelStartError())
        }
      }, 30_000)

      Promise.race(streams.map(s => checkStream(s!))).then(() => clearTimeout(timer))
    })
  }
}

export class TunnelAlreadyRunningError extends Error {
  constructor() {
    super('Tunnel is already running')
    this.name = 'TunnelAlreadyRunningError'
  }
}

export class TunnelStartError extends Error {
  constructor() {
    super('Tunnel failed to start within 30 seconds')
    this.name = 'TunnelStartError'
  }
}

export class CloudflaredNotFoundError extends Error {
  constructor() {
    super('cloudflared not found. Install: brew install cloudflared')
    this.name = 'CloudflaredNotFoundError'
  }
}
