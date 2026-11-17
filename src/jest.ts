import { CassetteConfigError } from "./errors.js";
import { type RunnerHooks, type RunnerOptions, registerCassetteHooks } from "./runner.js";
import { clearTrace } from "./trace.js";

type JestGlobals = Partial<Omit<RunnerHooks, "getState">> & {
  expect?: { getState(): { currentTestName?: string; testPath?: string } };
};

/**
 * Helper Jest : une cassette par test, nommée d'après le fichier et le titre du test.
 * À appeler dans un fichier `setupFilesAfterEnv` de la config Jest.
 *
 * @example
 * // jest.setup.js
 * const { setupLlmCassettes } = require("@appystore/llm-crashtest/jest");
 * setupLlmCassettes({ dir: "tests/__cassettes__" });
 */
export function setupLlmCassettes(options: RunnerOptions): void {
  const g = globalThis as JestGlobals;
  const { beforeAll, beforeEach, afterEach, afterAll, expect } = g;
  if (!beforeAll || !beforeEach || !afterEach || !afterAll || !expect) {
    throw new CassetteConfigError(
      "setupLlmCassettes : globals Jest introuvables. Appelez-le depuis un fichier `setupFilesAfterEnv`.",
    );
  }
  registerCassetteHooks(options, {
    beforeAll,
    beforeEach,
    afterEach,
    afterAll,
    getState: () => expect.getState(),
  });
}

/**
 * `globalSetup` Jest : efface la trace du run précédent (pour `prune` et `stale`).
 *
 * @example
 * // jest.config.js
 * // jest.global-setup.cjs
 * module.exports = require("@appystore/llm-crashtest/jest").globalSetup;
 * // jest.config.js
 * module.exports = { globalSetup: "./jest.global-setup.cjs", setupFilesAfterEnv: ["./jest.setup.js"] };
 */
export function globalSetup(): void {
  clearTrace();
}

export type { RunnerOptions } from "./runner.js";
