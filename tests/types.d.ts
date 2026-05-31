/// <reference types="vitest" />
// Tests-only ambient declarations. vitest runs in node so `process.env`
// is available at runtime; this satisfies the strict typechecker without
// pulling in the entire @types/node surface.
declare const process: { env: Record<string, string | undefined> };
