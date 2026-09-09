import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The reverse-search tests run real ~4M-candidate passes at production's 1044
    // ability modulus (kept deliberately real, not shrunk -- a smaller modulus makes
    // the h-value enumeration *more* expensive, not less; see randomizer.test.ts).
    // That's tens of seconds of real work in CI-grade hardware, well past the 5s
    // default.
    testTimeout: 60000,
  },
})
