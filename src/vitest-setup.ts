// Fichier de setup injecté par le plugin `llmCassette` : ne pas importer directement.
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject } from "vitest";
import { registerCassetteHooks } from "./runner.js";
import { deserializeRunnerOptions, type SerializedRunnerOptions } from "./serialize.js";

const PROVIDE_KEY = "llmCrashtestOptions";

const raw = (inject as (key: string) => unknown)(PROVIDE_KEY) as
  | SerializedRunnerOptions
  | undefined;
if (!raw) {
  throw new Error(
    "llm-crashtest : options introuvables. Ajoutez le plugin `llmCassette({ dir })` à vitest.config.",
  );
}

registerCassetteHooks(deserializeRunnerOptions(raw), {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  getState: () => expect.getState(),
});
