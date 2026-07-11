import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import path from "node:path"

// electrobun ships only .ts sources but its internal imports use `.js`
// specifiers (NodeNext style). The webview's native folder picker
// (lib/pickFolder.ts) lazily imports "electrobun/view"; this rewrites those
// `.js` deep-imports to their `.ts` sibling so the production build can resolve
// them. Scoped to electrobun importers so nothing else is affected.
function electrobunTsResolve(): Plugin {
  return {
    name: "electrobun-ts-resolve",
    enforce: "pre",
    async resolveId(source, importer) {
      if (importer && importer.includes("/electrobun/") && source.endsWith(".js")) {
        const asTs = source.replace(/\.js$/, ".ts")
        const resolved = await this.resolve(asTs, importer, { skipSelf: true })
        if (resolved) return resolved
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [react(), electrobunTsResolve()],
  root: "src/mainview",
  publicDir: "public",
  resolve: {
    alias: {
      "@chunky/protocol": path.resolve(__dirname, "../protocol/src/index.ts"),
    },
  },
  // electrobun ships .ts sources; let electrobunTsResolve handle its deep imports
  // rather than esbuild's dep pre-bundler (which can't rewrite `.js`→`.ts`).
  optimizeDeps: {
    exclude: ["electrobun"],
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
