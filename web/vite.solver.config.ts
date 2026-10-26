import { defineConfig } from 'vite'

// Bundles the solver CLI and its worker into plain Node ESM under dist-solver/.
export default defineConfig({
  build: {
    ssr: true,
    outDir: 'dist-solver',
    emptyOutDir: true,
    target: 'node24',
    rollupOptions: {
      input: {
        solverCli: 'src/engine/sim/driver/solverCli.ts',
        solverWorker: 'src/engine/sim/driver/solverWorker.ts',
      },
      output: { entryFileNames: '[name].mjs', format: 'es' },
    },
  },
})
