import { SecretDetectedError } from "./errors.js";
import { type JsonValue, mapStrings } from "./json.js";

export const REDACTED = "[REDACTED]";

export interface RedactOptions {
  /**
   * Motifs masqués (remplacés par `[REDACTED]`) dans les URL, corps et en-têtes
   * avant l'écriture. S'ajoutent aux valeurs des en-têtes d'authentification,
   * toujours masquées.
   */
  patterns?: readonly RegExp[];
  /** En-têtes de requête supplémentaires dont la valeur est un secret à masquer partout. */
  headers?: readonly string[];
  /** En-têtes de réponse supplémentaires à conserver (liste blanche, insensible à la casse). */
  keepResponseHeaders?: readonly string[];
}

/** En-têtes de requête dont la valeur est un identifiant. Les en-têtes de requête ne sont jamais écrits. */
export const AUTH_HEADERS: readonly string[] = [
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "ocp-apim-subscription-key",
  "cookie",
];

/**
 * Seuls ces en-têtes de réponse sont écrits (liste blanche) : `set-cookie`,
 * identifiants d'organisation, etc. ne finissent jamais dans une cassette.
 */
const SAFE_RESPONSE_HEADERS: readonly RegExp[] = [
  /^content-type$/,
  /^retry-after(-ms)?$/,
  /^x-ratelimit-[a-z-]+$/,
  /^anthropic-ratelimit-[a-z-]+$/,
  /^x-request-id$/,
  /^request-id$/,
];

/** Détecteurs de secrets connus. Une correspondance après masquage bloque l'écriture. */
const DETECTORS: readonly { name: string; re: RegExp }[] = [
  { name: "clé API Anthropic", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  // OpenAI, DeepSeek, OpenRouter (sk-or-v1-…) partagent le préfixe sk-.
  {
    name: "clé API sk- (OpenAI, DeepSeek, OpenRouter…)",
    re: /\bsk-(?:proj-|svcacct-|admin-|or-v1-)?[A-Za-z0-9_-]{20,}/,
  },
  { name: "clé API Google", re: /\bAIza[0-9A-Za-z_-]{35}/ },
  { name: "jeton OAuth Google (Vertex AI)", re: /\bya29\.[0-9A-Za-z_-]{20,}/ },
  { name: "clé API Groq", re: /\bgsk_[A-Za-z0-9]{40,}/ },
  { name: "clé API xAI", re: /\bxai-[A-Za-z0-9]{40,}/ },
  { name: "clé API Perplexity", re: /\bpplx-[A-Za-z0-9]{40,}/ },
  { name: "jeton Hugging Face", re: /\bhf_[A-Za-z0-9]{30,}/ },
  { name: "clé API Fireworks", re: /\bfw_[A-Za-z0-9]{20,}/ },
  { name: "jeton GitHub", re: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "clé d'accès AWS", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "jeton Bearer", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i },
  { name: "clé privée", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** Longueur minimale d'une valeur d'en-tête pour être masquée partout (évite de masquer « replay »). */
const MIN_SECRET_LENGTH = 16;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toGlobal(re: RegExp): RegExp {
  return re.flags.includes("g")
    ? new RegExp(re.source, re.flags)
    : new RegExp(re.source, `${re.flags}g`);
}

export class Redactor {
  readonly #patterns: RegExp[];
  readonly #keepHeaders: Set<string>;

  constructor(options: RedactOptions = {}, secretValues: readonly string[] = []) {
    const literals = [...new Set(secretValues)]
      .filter((v) => v.length >= MIN_SECRET_LENGTH)
      // Les plus longues d'abord, pour qu'une valeur incluse dans une autre ne laisse pas de reste.
      .sort((a, b) => b.length - a.length)
      .map((v) => new RegExp(escapeRegExp(v), "g"));
    this.#patterns = [...literals, ...(options.patterns ?? []).map(toGlobal)];
    this.#keepHeaders = new Set((options.keepResponseHeaders ?? []).map((h) => h.toLowerCase()));
  }

  /** Extrait les valeurs secrètes des en-têtes d'une requête (sans le préfixe `Bearer`). */
  static secretsFromHeaders(headers: Headers, extra: readonly string[] = []): string[] {
    const names = [...AUTH_HEADERS, ...extra.map((h) => h.toLowerCase())];
    const out: string[] = [];
    for (const name of names) {
      const value = headers.get(name);
      if (!value) continue;
      out.push(value);
      const m = /^(?:bearer|basic)\s+(.+)$/i.exec(value);
      if (m?.[1]) out.push(m[1]);
    }
    return out;
  }

  maskString(s: string): string {
    let out = s;
    for (const re of this.#patterns) {
      re.lastIndex = 0;
      out = out.replace(re, REDACTED);
    }
    return out;
  }

  maskJson(value: JsonValue): JsonValue {
    return mapStrings(value, (s) => this.maskString(s));
  }

  /** Filtre (liste blanche) puis masque les en-têtes de réponse. */
  responseHeaders(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    const names = [...headers.keys()].sort();
    for (const name of names) {
      const keep = this.#keepHeaders.has(name) || SAFE_RESPONSE_HEADERS.some((re) => re.test(name));
      const value = headers.get(name);
      if (keep && value !== null) out[name] = this.maskString(value);
    }
    return out;
  }

  /**
   * Dernier filet : lève une `SecretDetectedError` si un motif de secret subsiste.
   * La valeur du secret n'apparaît jamais dans le message (OWASP A09).
   */
  assertNoSecrets(sections: Record<string, JsonValue>): void {
    const findings: { location: string; detector: string }[] = [];
    for (const [section, value] of Object.entries(sections)) {
      mapStrings(value, (s, path) => {
        for (const d of DETECTORS) {
          if (d.re.test(s))
            findings.push({ location: path ? `${section}.${path}` : section, detector: d.name });
        }
        return s;
      });
    }
    if (findings.length === 0) return;
    const lines = findings.slice(0, 10).map((f) => `  - ${f.detector} dans ${f.location}`);
    throw new SecretDetectedError(
      [
        "llm-crashtest : secret probable détecté, la cassette n'a PAS été écrite.",
        ...lines,
        "Si c'est un faux positif ou une donnée à masquer, ajoutez un motif :",
        "  cassetteFetch({ redact: { patterns: [/votre-motif/] } })",
      ].join("\n"),
      findings,
    );
  }
}
