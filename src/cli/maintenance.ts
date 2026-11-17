import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { loadCassette } from "../store.js";
import { type CassetteTrace, readTrace } from "../trace.js";
import { display, isInside, listCassetteFiles } from "./files.js";

export interface Io {
  log(line: string): void;
  error(line: string): void;
}

/** Contexte d'une commande : sorties et dossier du projet (paramétrable pour les tests). */
export interface Ctx {
  io: Io;
  cwd: string;
}

const NO_TRACE =
  "Aucune trace de run. Lancez d'abord vos tests avec le plugin Vitest ou le helper Jest.";

async function requireTrace({ io, cwd }: Ctx): Promise<Map<string, CassetteTrace> | null> {
  const trace = await readTrace(cwd);
  if (!trace) io.error(NO_TRACE);
  return trace;
}

/** Cassettes présentes dans `dir` mais jamais lues pendant le dernier run. */
export async function prune(dir: string, opts: { yes: boolean }, ctx: Ctx): Promise<number> {
  const { io, cwd } = ctx;
  const root = path.resolve(cwd, dir);
  const trace = await requireTrace(ctx);
  if (!trace) return 2;
  const unused = (await listCassetteFiles(root)).filter((f) => !trace.has(f));
  if (unused.length === 0) {
    io.log("Aucune cassette inutilisée.");
    return 0;
  }
  io.log(`${unused.length} cassette(s) non lue(s) pendant le dernier run :`);
  for (const f of unused) io.log(`  - ${display(f, cwd)}`);
  if (!opts.yes) {
    io.log("\nRien n'a été supprimé. Relancez avec --yes pour supprimer ces fichiers.");
    io.log(
      "Attention : un run partiel (un seul fichier de test, -t …) produit une trace partielle.",
    );
    return 0;
  }
  let deleted = 0;
  for (const f of unused) {
    // Ne supprime qu'une vraie cassette, et uniquement dans `dir`.
    if (!isInside(root, f)) continue;
    try {
      await loadCassette(f);
    } catch {
      io.error(`  ignoré (pas une cassette valide) : ${display(f, cwd)}`);
      continue;
    }
    await rm(f);
    deleted++;
  }
  io.log(`${deleted} cassette(s) supprimée(s).`);
  return 0;
}

export interface StaleCassette {
  file: string;
  unusedInteractions: number;
  misses: number;
}

export async function findStale(
  root: string,
  trace: Map<string, CassetteTrace>,
): Promise<StaleCassette[]> {
  const files = new Set(await listCassetteFiles(root));
  const out: StaleCassette[] = [];
  for (const [file, t] of trace) {
    if (!files.has(file)) continue;
    const unused = t.known ? [...t.known].filter((k) => !t.used.has(k)).length : 0;
    if (unused > 0 || t.misses > 0)
      out.push({ file, unusedInteractions: unused, misses: t.misses });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** Cassettes dont une requête ne correspond plus (interactions jamais rejouées, ou rejeux manqués). */
export async function stale(dir: string, opts: { check: boolean }, ctx: Ctx): Promise<number> {
  const { io, cwd } = ctx;
  const trace = await requireTrace(ctx);
  if (!trace) return 2;
  const list = await findStale(path.resolve(cwd, dir), trace);
  if (list.length === 0) {
    io.log("Aucune cassette périmée.");
    return 0;
  }
  io.log(`${list.length} cassette(s) périmée(s) :`);
  for (const s of list) {
    const why = [
      s.unusedInteractions ? `${s.unusedInteractions} interaction(s) jamais rejouée(s)` : "",
      s.misses ? `${s.misses} requête(s) sans correspondance` : "",
    ]
      .filter(Boolean)
      .join(", ");
    io.log(`  - ${display(s.file, cwd)} (${why})`);
  }
  io.log("\nPour les ré-enregistrer : npx llm-crashtest rerecord --stale -- <commande de test>");
  return opts.check ? 1 : 0;
}

/** Supprime les cassettes périmées puis relance la commande de test en mode `auto`. */
export async function rerecord(dir: string, command: string[], ctx: Ctx): Promise<number> {
  const { io, cwd } = ctx;
  const root = path.resolve(cwd, dir);
  const trace = await requireTrace(ctx);
  if (!trace) return 2;
  const list = await findStale(root, trace);
  if (list.length === 0) {
    io.log("Aucune cassette périmée : rien à ré-enregistrer.");
    return 0;
  }
  for (const s of list) {
    if (!isInside(root, s.file)) continue;
    await rm(s.file, { force: true });
    io.log(`  supprimée : ${display(s.file, cwd)}`);
  }
  if (command.length === 0) {
    io.log("\nLancez maintenant vos tests avec LLM_CASSETTE=auto (clés API nécessaires).");
    return 0;
  }
  const [cmd, ...args] = command as [string, ...string[]];
  io.log(`\nRé-enregistrement : ${command.join(" ")} (LLM_CASSETTE=auto)`);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      env: { ...process.env, LLM_CASSETTE: "auto" },
      // Les .cmd (npm, npx) exigent un shell sous Windows. La commande vient de l'utilisateur.
      shell: process.platform === "win32",
    });
    child.on("error", (err) => {
      io.error(`Impossible de lancer la commande : ${err.message}`);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
