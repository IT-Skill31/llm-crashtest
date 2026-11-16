import path from "node:path";
import { CassetteMissError } from "./errors.js";
import { flatten, type JsonValue } from "./json.js";
import { type KeyOptions, type NormalizedRequest, normalizeRequest } from "./key.js";
import type { Redactor } from "./redact.js";
import type { Interaction } from "./store.js";

const MAX_LINES = 10;
const MAX_VALUE = 80;

function short(s: string | undefined, redactor: Redactor): string {
  if (s === undefined) return "(absent)";
  const masked = redactor.maskString(s);
  return masked.length > MAX_VALUE ? `${masked.slice(0, MAX_VALUE)}…` : masked;
}

function recordedNormalized(it: Interaction, options: KeyOptions): NormalizedRequest | null {
  try {
    const body = it.request.body;
    const text = typeof body === "string" ? body : body === null ? "" : JSON.stringify(body);
    return normalizeRequest(it.request.method, new URL(it.request.url), text, options);
  } catch {
    return null;
  }
}

function bodyDiff(a: JsonValue, b: JsonValue): [string, string | undefined, string | undefined][] {
  const fa = flatten(a);
  const fb = flatten(b);
  const keys = [...new Set([...fa.keys(), ...fb.keys()])].sort();
  return keys
    .filter((k) => fa.get(k) !== fb.get(k))
    .map((k): [string, string | undefined, string | undefined] => [k, fb.get(k), fa.get(k)]);
}

/** Construit l'erreur de mode `replay`, avec le diff vers l'interaction enregistrée la plus proche. */
export function describeMiss(
  received: NormalizedRequest,
  interactions: readonly Interaction[],
  options: KeyOptions,
  file: string,
  redactor: Redactor,
): CassetteMissError {
  const where = `${received.method} ${received.host}${received.path}`;
  const header = [
    `llm-crashtest : aucune interaction enregistrée pour ${where}`,
    `  cassette : ${path.basename(file)} (mode replay, aucun appel réseau effectué)`,
  ];
  const sameEndpoint = interactions
    .map((it) => recordedNormalized(it, options))
    .filter(
      (n): n is NormalizedRequest =>
        n !== null &&
        n.method === received.method &&
        n.host === received.host &&
        n.path === received.path,
    );

  if (interactions.length === 0) {
    header.push("  La cassette est vide ou absente. Enregistrez-la avec LLM_CASSETTE=auto.");
    return new CassetteMissError(header.join("\n"));
  }
  if (sameEndpoint.length === 0) {
    header.push("  Aucun appel enregistré sur cet endpoint. Endpoints présents :");
    const seen = [
      ...new Set(
        interactions.map((it) => `${it.request.method} ${short(it.request.url, redactor)}`),
      ),
    ];
    for (const e of seen.slice(0, MAX_LINES)) header.push(`    - ${e}`);
    return new CassetteMissError(header.join("\n"));
  }

  let best: ReturnType<typeof bodyDiff> = [];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const rec of sameEndpoint) {
    const d = bodyDiff(rec.body, received.body);
    const q = JSON.stringify(rec.query) === JSON.stringify(received.query) ? 0 : 1;
    if (d.length + q < bestScore) {
      best = d;
      bestScore = d.length + q;
    }
  }
  if (best.length === 0) {
    header.push(
      "  La requête correspond à un appel enregistré, mais elle est faite plus de fois",
      "  que pendant l'enregistrement (les appels identiques sont rejoués dans l'ordre).",
    );
  } else {
    header.push("  Différences avec l'appel enregistré le plus proche (corps de la requête) :");
    for (const [p, recorded, got] of best.slice(0, MAX_LINES)) {
      header.push(`    ${p || "(racine)"}`);
      header.push(`      enregistré : ${short(recorded, redactor)}`);
      header.push(`      reçu       : ${short(got, redactor)}`);
    }
    if (best.length > MAX_LINES) header.push(`    … et ${best.length - MAX_LINES} autre(s)`);
    header.push("  Si un champ change à chaque run (horodatage, id), ajoutez-le à `ignore`.");
  }
  return new CassetteMissError(header.join("\n"));
}
