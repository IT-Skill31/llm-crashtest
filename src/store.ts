import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CassetteConfigError, CassetteFormatError } from "./errors.js";
import { isPlainObject, type JsonValue } from "./json.js";

export const CASSETTE_VERSION = 1;

/** Taille maximale d'un fichier de cassette lu (OWASP API4). */
export const MAX_CASSETTE_BYTES = 50 * 1024 * 1024;

export interface RecordedRequest {
  method: string;
  url: string;
  body: JsonValue;
}

export interface RecordedResponse {
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  bodyEncoding: "json" | "text";
  body: JsonValue;
}

export interface Interaction {
  key: string;
  request: RecordedRequest;
  response: RecordedResponse;
  recordedAt: string;
}

export interface Cassette {
  version: typeof CASSETTE_VERSION;
  interactions: Interaction[];
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_NAME_LENGTH = 200;
const MAX_SEGMENT_LENGTH = 100;

/**
 * Transforme un nom de cassette (ex. `chat/résumé article`) en chemin sûr sous `dir`.
 * Refuse toute sortie du dossier (traversée de chemin, chemins absolus).
 */
export function resolveCassettePath(dir: string, name: string): string {
  if (typeof name !== "string" || name.trim() === "" || name.length > MAX_NAME_LENGTH) {
    throw new CassetteConfigError(`Nom de cassette invalide (1 à ${MAX_NAME_LENGTH} caractères).`);
  }
  const segments = name.split(/[\\/]+/).filter((s) => s !== "");
  const safe = segments.map((seg) => {
    if (seg === "." || seg === "..") {
      throw new CassetteConfigError(`Nom de cassette invalide : "${name}" (segment "${seg}").`);
    }
    let s = seg
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._ -]/gu, "_")
      .replace(/[. ]+$/, "")
      .slice(0, MAX_SEGMENT_LENGTH);
    if (s === "" || /^\.+$/.test(s)) s = "_";
    if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
    return s;
  });
  if (safe.length === 0) throw new CassetteConfigError(`Nom de cassette invalide : "${name}".`);

  const root = path.resolve(dir);
  const file = path.resolve(root, ...safe.slice(0, -1), `${safe.at(-1)}.json`);
  const rel = path.relative(root, file);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new CassetteConfigError(`Le nom de cassette "${name}" sort du dossier des cassettes.`);
  }
  return file;
}

function fail(file: string, detail: string): never {
  throw new CassetteFormatError(`Cassette invalide (${path.basename(file)}) : ${detail}`);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return isPlainObject(v) && Object.values(v).every((x) => typeof x === "string");
}

/** Valide un contenu de cassette lu sur disque : il est traité comme une entrée non fiable (OWASP A08). */
export function validateCassette(data: unknown, file: string): Cassette {
  if (!isPlainObject(data)) fail(file, "la racine doit être un objet");
  if (data["version"] !== CASSETTE_VERSION) {
    fail(
      file,
      `version ${String(data["version"])} non prise en charge (attendu ${CASSETTE_VERSION})`,
    );
  }
  const list = data["interactions"];
  if (!Array.isArray(list)) fail(file, "`interactions` doit être un tableau");
  list.forEach((it: unknown, i) => {
    const at = `interactions[${i}]`;
    if (!isPlainObject(it)) fail(file, `${at} doit être un objet`);
    if (typeof it["key"] !== "string" || !/^sha256:[0-9a-f]{64}$/.test(it["key"])) {
      fail(file, `${at}.key invalide`);
    }
    const req = it["request"];
    if (
      !isPlainObject(req) ||
      typeof req["method"] !== "string" ||
      typeof req["url"] !== "string"
    ) {
      fail(file, `${at}.request invalide`);
    }
    const res = it["response"];
    if (
      !isPlainObject(res) ||
      !Number.isInteger(res["status"]) ||
      (res["status"] as number) < 200 ||
      (res["status"] as number) > 599 ||
      !isStringRecord(res["headers"]) ||
      (res["bodyEncoding"] !== "json" && res["bodyEncoding"] !== "text") ||
      (res["bodyEncoding"] === "text" && typeof res["body"] !== "string")
    ) {
      fail(file, `${at}.response invalide`);
    }
    if (typeof it["recordedAt"] !== "string") fail(file, `${at}.recordedAt invalide`);
  });
  return data as unknown as Cassette;
}

/** Lit une cassette. Renvoie `null` si le fichier n'existe pas. */
export async function loadCassette(file: string): Promise<Cassette | null> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (size > MAX_CASSETTE_BYTES) fail(file, `fichier trop volumineux (${size} octets)`);
  const text = await readFile(file, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    fail(file, "JSON illisible");
  }
  return validateCassette(data, file);
}

/** Écriture atomique (fichier temporaire puis renommage) : jamais de cassette à moitié écrite. */
export async function saveCassette(file: string, cassette: Cassette): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(cassette, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
