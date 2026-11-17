import { CassetteConfigError } from "./errors.js";
import {
  type CassetteFetch,
  type CassetteOptions,
  type CassetteUsage,
  cassetteFetch,
} from "./fetch.js";

type Fetch = typeof globalThis.fetch;

interface GlobalState {
  original: Fetch;
  proxy: Fetch;
  active: CassetteFetch | undefined;
  created: CassetteFetch[];
  defaults: Partial<CassetteOptions> | undefined;
}

/**
 * État stocké sur `globalThis` via un symbole partagé : les builds ESM et CJS du package
 * (chargés tous deux dans certains projets) voient le même proxy et la même cassette active.
 */
const STATE = Symbol.for("llm-crashtest.global-state");
type Holder = { [STATE]?: GlobalState };

function state(): GlobalState | undefined {
  return (globalThis as Holder)[STATE];
}

/**
 * Remplace `globalThis.fetch` par un proxy stable qui délègue à la cassette active,
 * ou au `fetch` d'origine quand aucune cassette n'est active. Idempotent.
 *
 * À appeler avant la création des clients SDK (fichier de setup des tests) : certains SDK
 * capturent `fetch` à leur construction.
 */
export function installGlobalFetch(): void {
  if (state()) return;
  const original = globalThis.fetch;
  if (typeof original !== "function") throw new CassetteConfigError("Aucun `fetch` global.");
  const s: GlobalState = {
    original,
    active: undefined,
    created: [],
    defaults: undefined,
    proxy: ((input, init) => (s.active ?? s.original)(input, init)) as Fetch,
  };
  (globalThis as Holder)[STATE] = s;
  globalThis.fetch = s.proxy;
}

/** Restaure le `fetch` d'origine (si personne ne l'a remplacé depuis). */
export function uninstallGlobalFetch(): void {
  const s = state();
  if (!s) return;
  if (globalThis.fetch === s.proxy) globalThis.fetch = s.original;
  delete (globalThis as Holder)[STATE];
}

/** Options par défaut des cassettes créées par `useCassette` (dossier, mode, hôtes…). */
export function configureCassettes(defaults: Partial<CassetteOptions>): void {
  installGlobalFetch();
  const s = state() as GlobalState;
  s.defaults = { ...defaults };
}

/**
 * Active une cassette pour tous les appels passant par `globalThis.fetch`
 * (SDK sans option `fetch`, comme `@google/genai`). Remplace la cassette active.
 *
 * @example
 * await useCassette("resume-article", { faults: [{ on: 1, type: "http", status: 529 }] });
 */
export async function useCassette(
  name: string,
  options: Partial<CassetteOptions> = {},
): Promise<CassetteFetch> {
  installGlobalFetch();
  const s = state() as GlobalState;
  const merged = { ...s.defaults, ...options };
  if (!merged.dir) {
    throw new CassetteConfigError(
      "`useCassette` : précisez `dir`, ou appelez `configureCassettes({ dir })` (fait par le plugin Vitest).",
    );
  }
  await s.active?.flush();
  const f = cassetteFetch({ ...merged, dir: merged.dir, name, fetch: merged.fetch ?? s.original });
  s.active = f;
  s.created.push(f);
  return f;
}

/** Désactive la cassette courante, attend les écritures et renvoie l'usage de chaque cassette. */
export async function ejectCassette(): Promise<CassetteUsage[]> {
  const s = state();
  if (!s) return [];
  const created = s.created;
  s.active = undefined;
  s.created = [];
  await Promise.all(created.map((f) => f.flush()));
  return created.map((f) => f.usage());
}

/** Cassette actuellement active en mode global, s'il y en a une. */
export function activeCassette(): CassetteFetch | undefined {
  return state()?.active;
}
