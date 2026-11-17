import path from "node:path";
import { defineConfig } from "vitest/config";
// Dans votre projet : import { llmCassette } from "@appystore/llm-crashtest/vitest";
import { llmCassette } from "../dist/vitest.js";

export default defineConfig({
  plugins: [llmCassette({ dir: "examples/__cassettes__" })],
  resolve: {
    // Les exemples importent le package par son nom, comme dans votre projet.
    alias: { "@appystore/llm-crashtest": path.resolve(import.meta.dirname, "../dist/index.js") },
  },
  test: {
    include: ["examples/**/*.example.ts"],
    // Les exemples doivent tourner sans clé ni réseau : un appel non simulé échoue.
    env: { LLM_CASSETTE: "replay" },
  },
});
