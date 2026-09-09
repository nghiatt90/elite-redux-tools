import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    // The damage-calc engine (src/engine/**) is pure TS with no DOM dependency -- no
    // jsdom environment needed, and none is installed.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
})
