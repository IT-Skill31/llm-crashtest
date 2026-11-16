import { createHash } from "node:crypto";
import { CassetteConfigError } from "./errors.js";
import { canonicalize, isPlainObject, type JsonValue } from "./json.js";

/** Paramètres d'URL qui portent des identifiants (ex. Gemini `?key=`) : exclus de la clé et masqués. */
export const SECRET_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "key",
  "api_key",
  "api-key",
  "apikey",
  "access_token",
  "token",
]);

export interface NormalizedRequest {
  method: string;
  host: string;
  path: string;
  query: [string, string][];
  body: JsonValue;
}

export interface KeyOptions {
  /** Champs de premier niveau du corps pris en compte. Par défaut : tous. */
  match?: readonly string[] | undefined;
  /** Chemins exclus du hash, ex. `metadata.user_id` ou `messages.*.timestamp`. */
  ignore?: readonly string[] | undefined;
}

/** Corps de requête : JSON si possible, sinon texte brut, `null` si vide. */
export function parseBody(text: string): JsonValue {
  if (text === "") return null;
  try {
    return canonicalize(JSON.parse(text));
  } catch {
    return text;
  }
}

function parsePath(path: string): string[] {
  const segments = path.split(".");
  if (segments.some((s) => s === "")) {
    throw new CassetteConfigError(`Chemin \`ignore\` invalide : "${path}"`);
  }
  return segments;
}

function removePath(value: JsonValue, segments: readonly string[]): JsonValue {
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      if (head !== "*" && String(i) !== head) return item;
      return rest.length === 0 ? "[ignored]" : removePath(item, rest);
    });
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([k, v]): [string, JsonValue][] => {
        if (head !== "*" && k !== head) return [[k, v]];
        return rest.length === 0 ? [] : [[k, removePath(v, rest)]];
      }),
    );
  }
  return value;
}

/** Applique `match` puis `ignore` au corps, sans modifier l'original. */
export function selectBody(body: JsonValue, options: KeyOptions): JsonValue {
  let out = body;
  if (options.match && isPlainObject(out)) {
    const keep = new Set(options.match);
    out = Object.fromEntries(Object.entries(out).filter(([k]) => keep.has(k)));
  }
  for (const path of options.ignore ?? []) out = removePath(out, parsePath(path));
  return out;
}

export function normalizeRequest(
  method: string,
  url: URL,
  bodyText: string,
  options: KeyOptions,
): NormalizedRequest {
  const query = [...url.searchParams.entries()]
    .filter(([k]) => !SECRET_QUERY_PARAMS.has(k.toLowerCase()))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  return {
    method: method.toUpperCase(),
    // Le port n'est volontairement pas inclus : il change d'un run à l'autre en local.
    host: url.hostname.toLowerCase(),
    path: url.pathname,
    query,
    body: selectBody(parseBody(bodyText), options),
  };
}

export function computeKey(req: NormalizedRequest): string {
  const payload = JSON.stringify(canonicalize(req));
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

/** URL stockée dans la cassette : identifiants retirés de la query string. */
export function redactUrl(url: URL): string {
  const copy = new URL(url.href);
  copy.username = "";
  copy.password = "";
  for (const k of [...copy.searchParams.keys()]) {
    if (SECRET_QUERY_PARAMS.has(k.toLowerCase())) copy.searchParams.set(k, "[REDACTED]");
  }
  return copy.href;
}
