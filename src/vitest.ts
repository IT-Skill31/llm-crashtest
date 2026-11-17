import { fileURLToPath } from "node:url";
import { resolveMode } from "./fetch.js";
import type { RunnerOptions } from "./runner.js";
import { serializeRunnerOptions } from "./serialize.js";
import { clearTrace } from "./trace.js";

/** Clé `provide`/`inject` entre la config Vitest et le fichier de setup. */
export const PROVIDE_KEY = "llmCrashtestOptions";

/** Sous-ensemble du type `Plugin` de Vite : évite une dépendance de types à Vite. */
export interface LlmCassettePlugin {
  name: string;
  config(): { test: { setupFiles: string[]; provide: Record<string, unknown> } };
}

/**
 * Plugin Vitest : une cassette par test, nommée d'après le fichier et le titre du test.
 * Intercepte `globalThis.fetch`, donc aussi les SDK sans option `fetch`.
 *
 * @example
 * // vitest.config.ts
 * export default defineConfig({ plugins: [llmCassette({ dir: "tests/__cassettes__" })] });
 */
export function llmCassette(options: RunnerOptions): LlmCassettePlugin {
  const serialized = serializeRunnerOptions(options);
  // Valide le mode tôt (LLM_CASSETTE invalide = erreur de config, pas 200 tests en échec).
  resolveMode(options.mode);
  return {
    name: "llm-crashtest",
    config() {
      if (serialized.trace !== false) clearTrace();
      return {
        test: {
          setupFiles: [fileURLToPath(new URL("./vitest-setup.js", import.meta.url))],
          provide: { [PROVIDE_KEY]: serialized },
        },
      };
    },
  };
}

export type { RunnerOptions } from "./runner.js";
