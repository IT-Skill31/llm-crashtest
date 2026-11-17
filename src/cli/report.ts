import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isPlainObject, type JsonValue } from "../json.js";
import { type Cassette, type Interaction, MAX_CASSETTE_BYTES, validateCassette } from "../store.js";
import type { Ctx } from "./maintenance.js";

const run = promisify(execFile);
const MAX_SNIPPET = 90;
const MAX_DETAILS = 30;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    maxBuffer: MAX_CASSETTE_BYTES + 1024,
    encoding: "utf8",
  });
  return stdout;
}

/** Une référence git sûre : pas d'option déguisée (`--upload-pack=…`), pas de caractères exotiques. */
export function isSafeRef(ref: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._/~^@{}-]{0,200}$/.test(ref) && !ref.includes("..");
}

/**
 * Échappe un texte venant d'une cassette avant de l'insérer dans du Markdown de PR :
 * pas de HTML, pas de tableau cassé, pas de mention @ qui notifierait quelqu'un.
 */
export function escapeMd(s: string): string {
  return s
    .replace(/\r?\n|\r/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "'")
    .replace(/@/g, "@​")
    .replace(/[[\]]/g, (c) => `\\${c}`);
}

const snippet = (s: string) => {
  const one = s.replace(/\s+/g, " ").trim();
  return escapeMd(one.length > MAX_SNIPPET ? `${one.slice(0, MAX_SNIPPET)}…` : one);
};

function at(v: unknown, ...keys: (string | number)[]): unknown {
  let cur = v;
  for (const k of keys) {
    if (typeof k === "number") cur = Array.isArray(cur) ? cur[k] : undefined;
    else cur = isPlainObject(cur) ? cur[k] : undefined;
  }
  return cur;
}

/** Texte de la réponse, quel que soit le fournisseur (JSON ou flux SSE / NDJSON). */
export function responseText(it: Interaction): string {
  const pick = (b: unknown): string => {
    const candidates = [
      at(b, "choices", 0, "message", "content"),
      at(b, "choices", 0, "delta", "content"),
      at(b, "content", 0, "text"),
      at(b, "delta", "text"),
      at(b, "candidates", 0, "content", "parts", 0, "text"),
      at(b, "message", "content"),
      at(b, "message", "content", 0, "text"),
      at(b, "delta", "message", "content", "text"),
      at(b, "text"),
      at(b, "response"),
    ];
    return (candidates.find((c) => typeof c === "string") as string | undefined) ?? "";
  };
  if (it.response.bodyEncoding !== "stream") return pick(it.response.body);
  const text = (it.stream ?? []).map((c) => c.data).join("");
  let out = "";
  for (const line of text.split("\n")) {
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (!payload.startsWith("{")) continue;
    try {
      out += pick(JSON.parse(payload));
    } catch {
      // ligne partielle ou non JSON
    }
  }
  return out;
}

function models(c: Cassette | null): Set<string> {
  const out = new Set<string>();
  for (const it of c?.interactions ?? []) {
    const m = at(it.request.body, "model");
    if (typeof m === "string") out.add(m);
  }
  return out;
}

function parse(text: string, label: string): Cassette | null {
  try {
    return validateCassette(JSON.parse(text) as JsonValue, label);
  } catch {
    return null;
  }
}

interface Change {
  file: string;
  status: "added" | "modified" | "deleted";
  before: Cassette | null;
  after: Cassette | null;
}

type Pair = [before: Interaction, after: Interaction];

function summarize(change: Change): { added: number; removed: number; changed: Pair[] } {
  const before = new Map((change.before?.interactions ?? []).map((it) => [it.key, it]));
  const after = new Map((change.after?.interactions ?? []).map((it) => [it.key, it]));
  const changed: Pair[] = [];
  for (const [k, a] of after) {
    const b = before.get(k);
    if (b && responseText(b) !== responseText(a)) changed.push([b, a]);
  }
  return {
    added: [...after.keys()].filter((k) => !before.has(k)).length,
    removed: [...before.keys()].filter((k) => !after.has(k)).length,
    changed,
  };
}

export function renderReport(changes: readonly Change[], base: string): string {
  if (changes.length === 0)
    return `### LLM cassettes\n\nAucune cassette modifiée par rapport à \`${escapeMd(base)}\`.\n`;
  const count = (s: Change["status"]) => changes.filter((c) => c.status === s).length;
  const lines = [
    "### LLM cassettes",
    "",
    `${changes.length} cassette(s) modifiée(s) par rapport à \`${escapeMd(base)}\` : ` +
      `${count("added")} ajoutée(s), ${count("modified")} modifiée(s), ${count("deleted")} supprimée(s).`,
    "",
    "| Cassette | Changement | Interactions | Modèles |",
    "| --- | --- | --- | --- |",
  ];
  const details: string[] = [];
  for (const c of changes) {
    const s = summarize(c);
    const before = models(c.before);
    const after = models(c.after);
    const modelCell =
      [...before].sort().join(", ") === [...after].sort().join(", ")
        ? [...after].map(escapeMd).join(", ")
        : `${[...before].map(escapeMd).join(", ") || "–"} → ${[...after].map(escapeMd).join(", ") || "–"}`;
    const inter = [
      s.added ? `+${s.added}` : "",
      s.removed ? `−${s.removed}` : "",
      s.changed.length ? `~${s.changed.length} réponse(s)` : "",
    ]
      .filter(Boolean)
      .join(" ");
    const label = { added: "ajoutée", modified: "modifiée", deleted: "supprimée" }[c.status];
    const invalid = (c.status !== "deleted" && !c.after) || (c.status !== "added" && !c.before);
    lines.push(
      `| \`${escapeMd(c.file)}\` | ${label}${invalid ? " ⚠️ format invalide" : ""} | ${inter || "–"} | ${modelCell || "–"} |`,
    );
    for (const [b, a] of s.changed) {
      if (details.length >= MAX_DETAILS) break;
      details.push(
        `- \`${escapeMd(c.file)}\`\n  - avant : ${snippet(responseText(b)) || "(vide)"}\n  - après : ${snippet(responseText(a)) || "(vide)"}`,
      );
    }
  }
  if (details.length > 0) {
    lines.push(
      "",
      "<details><summary>Réponses modifiées</summary>",
      "",
      ...details,
      "",
      "</details>",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Résumé Markdown des cassettes modifiées entre `base` et l'arbre de travail. */
export async function report(
  dir: string,
  opts: { base: string; output?: string | undefined },
  { io, cwd }: Ctx,
): Promise<number> {
  if (!isSafeRef(opts.base)) {
    io.error(`Référence git invalide : ${JSON.stringify(opts.base)}`);
    return 2;
  }
  let root: string;
  try {
    root = path.resolve((await git(["rev-parse", "--show-toplevel"], cwd)).trim());
  } catch {
    io.error("Pas de dépôt git ici (ou git introuvable).");
    return 2;
  }
  const relDir = path.relative(root, path.resolve(cwd, dir)).split(path.sep).join("/") || ".";
  if (relDir.startsWith("..")) {
    io.error("Le dossier des cassettes est hors du dépôt git.");
    return 2;
  }
  let diff: string;
  try {
    diff = await git(
      ["diff", "--name-status", "--no-renames", "-z", opts.base, "--", relDir],
      root,
    );
  } catch {
    io.error(`Impossible de comparer avec ${JSON.stringify(opts.base)} (référence inconnue ?).`);
    return 2;
  }
  const parts = diff.split("\0").filter(Boolean);
  // `git diff` ignore les fichiers non suivis : nouvelles cassettes pas encore commitées.
  const untracked = (
    await git(["ls-files", "--others", "--exclude-standard", "-z", "--", relDir], root)
  )
    .split("\0")
    .filter(Boolean);
  for (const file of untracked) parts.push("A", file);
  const changes: Change[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i] as string;
    const file = parts[i + 1] as string;
    if (!file.endsWith(".json")) continue;
    const status = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
    const before =
      status === "added" ? null : parse(await git(["show", `${opts.base}:${file}`], root), file);
    let after: Cassette | null = null;
    if (status !== "deleted") {
      try {
        after = parse(await readFile(path.join(root, file), "utf8"), file);
      } catch {
        after = null;
      }
    }
    changes.push({ file, status, before, after });
  }
  const md = renderReport(changes, opts.base);
  if (opts.output) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.resolve(cwd, opts.output), md, "utf8");
    io.log(`Rapport écrit dans ${opts.output}`);
  } else {
    io.log(md);
  }
  return 0;
}
