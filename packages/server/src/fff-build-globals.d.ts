/**
 * Build-time constant used by @ff-labs/fff-bun's published TypeScript source.
 * Bun replaces it when compiling Linux binaries; normal tsc runs only need its
 * type so they can validate the dependency without modifying node_modules.
 */
declare const FFF_LIBC: "gnu" | "musl" | undefined
