// src/db/migrations.ts — SQLite schema setup + versioning
//
// V1 tables:
//   schema_version  — tracks migration version
//   credentials     — OAuth tokens + API keys
//   model_locks     — per-account lock expiry for backoff
//   usage           — request/response usage records (fire-and-forget writes)
//
// V2 tables (dashboard):
//   provider_limits  — last-seen x-ratelimit-* headers per provider/account
//   sessions         — admin session tokens (7-day rolling expiry)
//   login_attempts   — IP-based rate limiting for /dashboard/login
//   settings         — key/value config (admin_password_hash)
//
// ┌────────────────────────────────────────────────────────────────────────┐
// │  V1: schema_version  credentials  model_locks  usage                  │
// │  V2: provider_limits  sessions  login_attempts  settings               │
// └────────────────────────────────────────────────────────────────────────┘

import { Database } from 'bun:sqlite'
import * as fs from 'node:fs'
import * as path from 'node:path'

const DB_PATH = path.join(process.cwd(), 'data', 'router.db')

export function openDatabase(): Database {
  // Ensure data/ directory exists
  const dir = path.dirname(DB_PATH)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const db = new Database(DB_PATH)

  // Secure file permissions (owner read/write only)
  try {
    fs.chmodSync(DB_PATH, 0o600)
  } catch {
    // May fail on some platforms; non-fatal
  }

  // WAL mode for concurrent reads + fast writes
  db.run('PRAGMA journal_mode=WAL')
  db.run('PRAGMA foreign_keys=ON')

  runMigrations(db)
  return db
}

function runMigrations(db: Database): void {
  // Create version tracking table first
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    )
  `)

  const row = db.query('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | null
  const currentVersion = row?.version ?? 0

  if (currentVersion < 1) {
    migrateV1(db)
  }
  if (currentVersion < 2) {
    migrateV2(db)
  }
}

function migrateV1(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS credentials (
      provider_id    TEXT NOT NULL,
      account_id     TEXT NOT NULL,
      type           TEXT NOT NULL CHECK(type IN ('api_key', 'oauth')),
      value          TEXT NOT NULL,
      refresh_token  TEXT,
      expires_at     INTEGER,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      updated_at     INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
      PRIMARY KEY (provider_id, account_id)
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS model_locks (
      account_id     TEXT NOT NULL,
      model_id       TEXT NOT NULL,
      locked_until   INTEGER NOT NULL DEFAULT 0,
      attempt_count  INTEGER NOT NULL DEFAULT 0,
      last_error     INTEGER,
      PRIMARY KEY (account_id, model_id)
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS usage (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp          INTEGER NOT NULL,
      model_id           TEXT NOT NULL,
      provider_id        TEXT NOT NULL,
      account_id         TEXT NOT NULL,
      prompt_tokens      INTEGER NOT NULL DEFAULT 0,
      completion_tokens  INTEGER NOT NULL DEFAULT 0,
      total_tokens       INTEGER NOT NULL DEFAULT 0,
      duration_ms        INTEGER NOT NULL DEFAULT 0,
      streaming          INTEGER NOT NULL DEFAULT 0
    )
  `)

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage(timestamp)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model_id)
  `)

  // Upsert version
  db.run(`
    INSERT INTO schema_version (version) VALUES (1)
    ON CONFLICT DO UPDATE SET version = 1
  `)
}

function migrateV2(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS provider_limits (
      provider_id    TEXT NOT NULL,
      account_id     TEXT NOT NULL,
      limit_req      INTEGER,
      remaining_req  INTEGER,
      limit_tok      INTEGER,
      remaining_tok  INTEGER,
      reset_req_at   INTEGER,
      reset_tok_at   INTEGER,
      captured_at    INTEGER NOT NULL,
      PRIMARY KEY (provider_id, account_id)
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS login_attempts (
      ip           TEXT PRIMARY KEY,
      count        INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  db.run(`
    INSERT INTO schema_version (version) VALUES (2)
    ON CONFLICT DO UPDATE SET version = 2
  `)
}
