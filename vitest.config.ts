import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Les tests ne doivent jamais dépendre d'une variable CI/LLM_CASSETTE héritée.
    env: { LLM_CASSETTE: "" },
  },
});
