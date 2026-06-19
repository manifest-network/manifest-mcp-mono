// KNOWN-BAD FIXTURE (ENG-309) — NOT compiled into any package. See ../README.md.
//
// Simulates a browser-safe `src` barrel STATICALLY importing node builtins / undici at the top
// level (the edge that hard-fails a browser build before tree-shaking — ENG-281/287). A runtime-
// gated dynamic `import('node:fs')` would be browser-safe; this static form is the violation the
// production `no-static-node-in-browser-src` rule MUST flag.
import { readFileSync } from 'node:fs';
import { fetch as undiciFetch } from 'undici';

export const leak = { readFileSync, undiciFetch };
