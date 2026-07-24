#!/usr/bin/env node
// Thin launcher so `sae` works after `pnpm link --global` / global install.
// The real entry point is the compiled ESM in dist/, which runs on import
// (top-level await bootstraps the server).
import "../dist/index.js";
