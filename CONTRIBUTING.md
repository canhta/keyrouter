# Contributing to keyrouter

Thanks for your interest in contributing!

## Development Setup

**Prerequisites:** [Bun](https://bun.sh) ≥ 1.0

```bash
git clone https://github.com/canhta/keyrouter
cd keyrouter
bun install
```

## Running Tests

```bash
bun test
```

Tests use in-memory SQLite and mock `fetch` — no real provider credentials needed.

## Project Conventions

- **Runtime:** Bun only. No Node-specific APIs. See `CLAUDE.md` for the full list.
- **Types:** All shared interfaces live in `src/types.ts`. Do not create per-module type files.
- **Spread, don't destructure:** When forwarding request bodies, always use `{ ...body, model: upstreamId }` — destructuring silently strips unknown fields like `reasoning_opaque` that providers require.
- **Fire-and-forget writes:** Usage recording and provider limit capture use `.catch(console.warn)` — never `await` them in the hot path.
- **SQLite migrations:** Add a new `migrateVN()` call in `src/db/migrations.ts`. Never alter existing tables.

## Adding a Provider

1. Create `src/auth/<name>.ts` implementing `OAuthProvider` (device flow) or use `ApiKeyCredential` for API-key providers.
2. Create `src/providers/<name>.ts` implementing `ProviderDefinition` (baseUrl + requestHeaders).
3. Register both in `src/index.ts`.
4. Add unit tests in `tests/unit/<name>-oauth.test.ts` covering all `DevicePollResult` status codes.

See `src/auth/copilot.ts` as the reference OAuth implementation.

## Submitting a Pull Request

1. Fork the repo and create a branch from `main`.
2. Make your changes, add tests.
3. Run `bun test` — all tests must pass.
4. Open a PR against `main`. The PR template will guide you.

## Reporting Issues

Use [GitHub Issues](https://github.com/canhta/keyrouter/issues). For OAuth flows, include the provider name and the error message (but **never** include tokens or credentials).

## Security Vulnerabilities

Please do **not** open a public issue for security vulnerabilities. Email the maintainers directly or use GitHub's private security advisory feature.
