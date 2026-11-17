import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CassetteUsage } from "./fetch.js";
import { isPlainObject } from "./json.js";

/**
 * Trace des cassettes lues pendant le dernier run de tests. Stockée dans le cache de
 * `node_modules` : jamais commitée, effacée au début de chaque run par le plugin.
 */
export const TRACE_DIR = path.join("node_modules", ".cache", "llm-crashtest", "trace");
const TRACE_VERSION = 1;
const MAX_TRACE_FILE_BYTES = 20 * 1024 * 1024;

export interface TraceEntry {
  /** Chemin de la cassette, relatif au dossier courant, en `/`. */
  cassette: string;
  usedKeys: string[];
  knownKeys: string[] | null;
  misses: number;
}

export interface CassetteTrace {
  used: Set<string>;
  known: Set<string> | null;
  misses: number;
}

export function traceDir(cwd = process.cwd()): string {
  return path.resolve(cwd, TRACE_DIR);
}

/** Efface la trace (début de run). Synchrone : appelé depuis des hooks de configuration. */
export function clearTrace(cwd = process.cwd()): void {
  const dir = traceDir(cwd);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

const toPosix = (p: string) => p.split(path.sep).join("/");

export function toTraceEntries(
  usages: readonly CassetteUsage[],
  cwd = process.cwd(),
): TraceEntry[] {
  return usages
    .filter((u) => u.calls > 0)
    .map((u) => ({
      cassette: toPosix(path.relative(cwd, u.cassettePath)),
      usedKeys: u.usedKeys,
      knownKeys: u.knownKeys,
      misses: u.misses,
    }));
}

/** Un fichier par worker et par fichier de test : pas d'écriture concurrente sur un même fichier. */
export async function writeTrace(
  entries: readonly TraceEntry[],
  cwd = process.cwd(),
): Promise<void> {
  if (entries.length === 0) return;
  const dir = traceDir(cwd);
  mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}.json`,
  );
  await writeFile(file, JSON.stringify({ version: TRACE_VERSION, entries }), {
    encoding: "utf8",
    flag: "wx",
  });
}

function isEntry(e: unknown): e is TraceEntry {
  return (
    isPlainObject(e) &&
    typeof e["cassette"] === "string" &&
    Array.isArray(e["usedKeys"]) &&
    e["usedKeys"].every((k: unknown) => typeof k === "string") &&
    (e["knownKeys"] === null ||
      (Array.isArray(e["knownKeys"]) &&
        e["knownKeys"].every((k: unknown) => typeof k === "string"))) &&
    Number.isInteger(e["misses"])
  );
}

/** Fusionne toutes les traces du dernier run. Renvoie `null` si aucune trace n'existe. */
export async function readTrace(cwd = process.cwd()): Promise<Map<string, CassetteTrace> | null> {
  let files: string[];
  try {
    files = (await readdir(traceDir(cwd))).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const merged = new Map<string, CassetteTrace>();
  for (const f of files) {
    const text = await readFile(path.join(traceDir(cwd), f), "utf8");
    if (text.length > MAX_TRACE_FILE_BYTES) continue;
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      continue; // trace corrompue : ignorée
    }
    if (
      !isPlainObject(data) ||
      data["version"] !== TRACE_VERSION ||
      !Array.isArray(data["entries"])
    )
      continue;
    for (const e of data["entries"]) {
      if (!isEntry(e)) continue;
      const abs = path.resolve(cwd, e.cassette);
      const cur = merged.get(abs) ?? { used: new Set<string>(), known: null, misses: 0 };
      for (const k of e.usedKeys) cur.used.add(k);
      if (e.knownKeys) cur.known = new Set([...(cur.known ?? []), ...e.knownKeys]);
      cur.misses += e.misses;
      merged.set(abs, cur);
    }
  }
  return merged;
}
