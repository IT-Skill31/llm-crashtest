import { defineConfig } from "vitest/config";
import { llmCassette } from "../../../dist/vitest.js";

export default defineConfig({
  plugins: [llmCassette({ dir: "__cassettes__", hosts: ["127.0.0.1"] })],
  test: { include: ["*.e2e.ts"] },
});
