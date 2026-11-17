import { existsSync } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import {
  cassetteNameFor,
  ejectCassette,
  type RunnerHooks,
  registerCassetteHooks,
  uninstallGlobalFetch,
} from "../src/index.js";
import { deserializeRunnerOptions, serializeRunnerOptions } from "../src/serialize.js";
import { readTrace } from "../src/trace.js";
import { llmCassette } from "../src/vitest.js";
import { fakeLLMFetch } from "./fake-fetch.js";
import { tempDir } from "./helpers.js";

/** Runner simulé : permet de tester les hooks sans lancer un second Vitest. */
function fakeRunner() {
  const hooks: Record<string, (() => unknown)[]> = {
    beforeAll: [],
    beforeEach: [],
    afterEach: [],
    afterAll: [],
  };
  let state: { currentTestName?: string; testPath?: string } = {};
  const api: RunnerHooks = {
    beforeAll: (fn) => hooks["beforeAll"]?.push(fn),
    beforeEach: (fn) => hooks["beforeEach"]?.push(fn),
    afterEach: (fn) => hooks["afterEach"]?.push(fn),
    afterAll: (fn) => hooks["afterAll"]?.push(fn),
    getState: () => state,
  };
  const runAll = async (name: keyof typeof hooks) => {
    for (const fn of hooks[name] ?? []) await fn();
  };
  return {
    api,
    async test(testPath: string, name: string, body: () => Promise<void>) {
      state = { testPath, currentTestName: name };
      await runAll("beforeEach");
      try {
        await body();
      } finally {
        await runAll("afterEach");
      }
    },
    finish: () => runAll("afterAll"),
  };
}

describe("nommage des cassettes", () => {
  it("fichier sans extension + describe/test", () => {
    const cwd = path.resolve("/proj");
    expect(cassetteNameFor(path.resolve("/proj/tests/chat.test.ts"), "chat > répond", cwd)).toBe(
      "tests/chat.test/chat/répond",
    );
  });

  it("raccourcit les noms trop longs avec un hash stable", () => {
    const long = "x".repeat(400);
    const a = cassetteNameFor("/p/a.test.ts", long, "/p");
    expect(a.length).toBeLessThanOrEqual(180);
    expect(a).toBe(cassetteNameFor("/p/a.test.ts", long, "/p"));
    expect(a).not.toBe(cassetteNameFor("/p/a.test.ts", `${long}y`, "/p"));
  });

  it("ne sort jamais du dossier, même pour un fichier hors du projet", () => {
    expect(cassetteNameFor("/autre/x.test.ts", "t", "/proj/sub")).not.toContain("..");
  });
});

describe("hooks de runner (plugin Vitest / helper Jest)", () => {
  afterEach(async () => {
    await ejectCassette();
    uninstallGlobalFetch();
  });

  it("une cassette par test, client créé avant les hooks, trace écrite", async () => {
    const dir = await tempDir();
    const cwd = process.cwd();
    const runner = fakeRunner();
    const live = fakeLLMFetch();
    registerCassetteHooks({ dir, mode: "auto", hosts: ["api.openai.com"] }, runner.api);

    // Créé au chargement du fichier de test, avant tout beforeEach : capture le proxy.
    const client = new OpenAI({ apiKey: "replay", maxRetries: 0 });
    // Le « vrai réseau » de ce test : le fetch d'origine est remplacé par le faux serveur.
    const realFetch = globalThis.fetch;
    const { useCassette } = await import("../src/global.js");
    const ask = () =>
      client.chat.completions.create({ model: "m", messages: [{ role: "user", content: "x" }] });

    const testFile = path.join(cwd, "test", "demo.test.ts");
    await runner.test(testFile, "suite > premier", async () => {
      // Remplace la cassette du test pour router vers le faux serveur.
      await useCassette(cassetteNameFor(testFile, "suite > premier"), { dir, fetch: live });
      await ask();
    });
    expect(live.hits).toBe(1);
    expect(existsSync(path.join(dir, "test", "demo.test", "suite", "premier.json"))).toBe(true);
    expect(globalThis.fetch).toBe(realFetch);

    await runner.finish();
    const trace = await readTrace();
    expect(trace?.has(path.join(dir, "test", "demo.test", "suite", "premier.json"))).toBe(true);
  });
});

describe("plugin Vitest", () => {
  it("injecte le fichier de setup et des options sérialisables", () => {
    const plugin = llmCassette({
      dir: "tests/__cassettes__",
      redact: { patterns: [/user-\d+/gi] },
    });
    const cfg = plugin.config();
    expect(cfg.test.setupFiles[0]).toMatch(/vitest-setup\.js$/);
    const provided = cfg.test.provide["llmCrashtestOptions"];
    expect(JSON.parse(JSON.stringify(provided))).toEqual(provided);
  });

  it("aller-retour des options, RegExp comprises", () => {
    const back = deserializeRunnerOptions(
      serializeRunnerOptions({ dir: "d", redact: { patterns: [/a+b/gi] } }),
    );
    expect(back.redact?.patterns?.[0]?.source).toBe("a+b");
    expect(back.redact?.patterns?.[0]?.flags).toBe("gi");
  });
});
