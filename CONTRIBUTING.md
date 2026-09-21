# Contributing to sae

Thanks for your interest in contributing! This document explains how to set up
your environment, make changes, and open a pull request.

## Prerequisites

- [Node.js](https://nodejs.org) 22 or newer
- [pnpm](https://pnpm.io) 10 or newer

## Getting started

```bash
git clone https://github.com/rbtavares/sae.git
cd sae
pnpm install        # installs deps and builds dist/ via the prepare hook
```

Run sae locally:

```bash
pnpm start          # start on http://0.0.0.0:8545
pnpm dev            # rebuild + restart on file changes
```

## Development workflow

1. Create a branch off `main`:

   ```bash
   git checkout -b feature/short-description
   ```

2. Make your changes.

3. Before opening a PR, make sure all checks pass locally:

   ```bash
   pnpm run format:check   # formatting (oxfmt)
   pnpm run lint           # linting (oxlint)
   pnpm run typecheck       # TypeScript type checking
   pnpm run test           # tests (node:test)
   ```

   Run `pnpm run format` to auto-fix formatting issues.

4. Commit using [Conventional Commits](https://www.conventionalcommits.org/):

   ```
   feat: add retry backoff to websocket upstreams
   fix: correct block-lag comparison off-by-one
   docs: clarify config precedence in README
   ```

5. Push and open a pull request against `main`.

## Configuration during development

`default.config.json` is the committed baseline. To override it locally, create
a `config.json` in the repo root — it is gitignored and never committed. Config
resolution order is:

`default.config.json` → `config.json` → environment variables → CLI flags

Please do **not** commit real API keys or private endpoints.

## Tests

Tests use real local HTTP/WS servers as fake upstreams — no mocks. Add tests for
any new behavior. The suite runs with Node's built-in test runner:

```bash
pnpm run test
```

## Reporting bugs and requesting features

Use the [issue templates](https://github.com/rbtavares/sae/issues/new/choose).
For security issues, see [SECURITY.md](SECURITY.md) — do not open a public issue.

## Code of Conduct

By participating, you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).
