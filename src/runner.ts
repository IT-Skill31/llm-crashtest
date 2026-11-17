import { createHash } from "node:crypto";
import path from "node:path";
import type { CassetteOptions, CassetteUsage } from "./fetch.js";
import { configureCassettes, ejectCassette, installGlobalFetch, useCassette } from "./global.js";
import { toTraceEntries, writeTrace } from "./trace.js";

/** Options communes aux intégrations de runners (Vitest, Jest, node:test). */
export interface RunnerOptions extends Omit<CassetteOptions, "name" | "fetch" | "faults"> {
  /** Écrit la trace des cassettes lues (pour `prune` et `stale`). Par défaut `true`. */
  trace?: boolean;
}

type Hook = (fn: () => unknown) => unknown;

export interface RunnerHooks {
  beforeAll: Hook;
  beforeEach: Hook;
  afterEach: Hook;
  afterAll: Hook;
  /** `expect.getState` de Vitest ou Jest : nom du test courant et chemin du fichier. */
  getState: () => { currentTestName?: string | undefined; testPath?: string | undefined };
}

const MAX_NAME = 180;

/**
 * Nom de cassette déduit du test : `<fichier sans extension>/<describe>/<test>`.
 * Les noms trop longs sont raccourcis avec un hash pour rester uniques.
 */
export function cassetteNameFor(
  testPath: string | undefined,
  testName: string | undefined,
  cwd = process.cwd(),
): string {
  const rel = testPath
    ? path
        .relative(cwd, testPath)
        .replace(/\.[cm]?[jt]sx?$/, "")
        .split(/[\\/]+/)
        .filter((s) => s !== ".." && s !== ".")
        .join("/")
    : "unknown-file";
  // Vitest sépare describe et test par " > ".
  const test = (testName ?? "unnamed test").split(" > ").join("/");
  const full = `${rel}/${test}`;
  if (full.length <= MAX_NAME) return full;
  const hash = createHash("sha256").update(full).digest("hex").slice(0, 10);
  return `${full.slice(0, MAX_NAME - 11)}-${hash}`;
}

/**
 * Branche les cassettes sur un runner : une cassette par test, nommée automatiquement,
 * via un `fetch` global proxy. Utilisé par le plugin Vitest et le helper Jest.
 */
export function registerCassetteHooks(options: RunnerOptions, hooks: RunnerHooks): void {
  const { trace = true, ...cassetteOptions } = options;
  const usages: CassetteUsage[] = [];
  // Installé dès le chargement du setup : avant que les fichiers de test ne créent leurs clients.
  installGlobalFetch();
  configureCassettes(cassetteOptions);

  hooks.beforeEach(async () => {
    const { currentTestName, testPath } = hooks.getState();
    await useCassette(cassetteNameFor(testPath, currentTestName));
  });
  hooks.afterEach(async () => {
    usages.push(...(await ejectCassette()));
  });
  hooks.afterAll(async () => {
    if (trace) await writeTrace(toTraceEntries(usages));
  });
}
