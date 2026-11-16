import { describeMiss } from "./diff.js";
import { CassetteConfigError, CassetteError } from "./errors.js";
import { canonicalize, type JsonValue } from "./json.js";
import { computeKey, type KeyOptions, normalizeRequest, parseBody, redactUrl } from "./key.js";
import { DEFAULT_HOSTS, hostMatches } from "./providers/index.js";
import { type RedactOptions, Redactor } from "./redact.js";
import {
  CASSETTE_VERSION,
  type Cassette,
  type Interaction,
  loadCassette,
  resolveCassettePath,
  saveCassette,
} from "./store.js";

export const MODES = ["auto", "replay", "record", "passthrough"] as const;
export type Mode = (typeof MODES)[number];

export interface CassetteOptions extends KeyOptions {
  /** Dossier des cassettes, ex. `tests/__cassettes__`. */
  dir: string;
  /** Nom de la cassette (sous-dossiers autorisés avec `/`). Par défaut `default`. */
  name?: string;
  /** Prioritaire : variable `LLM_CASSETTE`. Par défaut `replay` si `CI` est défini, sinon `auto`. */
  mode?: Mode;
  /** Domaines interceptés (`api.x.com` ou `*.x.com`). Les autres requêtes passent sans être touchées. */
  hosts?: readonly string[];
  redact?: RedactOptions;
  /** `fetch` sous-jacent pour les vrais appels. Par défaut `globalThis.fetch` au moment de la création. */
  fetch?: typeof globalThis.fetch;
  /** Taille maximale d'un corps de requête ou de réponse enregistré, en octets. Par défaut 10 Mio. */
  maxBodyBytes?: number;
  /**
   * Enregistre aussi les réponses 429 et 5xx. Désactivé par défaut : une panne transitoire
   * pendant l'enregistrement ne doit pas être figée dans la cassette (utilisez plutôt `faults`).
   */
  recordTransientErrors?: boolean;
}

export interface CassetteFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  readonly mode: Mode;
  readonly cassettePath: string;
  /** Attend la fin des écritures de cassette en cours. */
  flush(): Promise<void>;
}

const DEFAULT_MAX_BODY = 10 * 1024 * 1024;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function isMode(v: string): v is Mode {
  return (MODES as readonly string[]).includes(v);
}

export function resolveMode(option?: Mode): Mode {
  const env = globalThis.process?.env ?? {};
  const fromEnv = env["LLM_CASSETTE"]?.trim().toLowerCase();
  if (fromEnv) {
    if (!isMode(fromEnv)) {
      throw new CassetteConfigError(
        `LLM_CASSETTE invalide. Valeurs possibles : ${MODES.join(", ")}.`,
      );
    }
    return fromEnv;
  }
  if (option !== undefined) {
    if (!isMode(option))
      throw new CassetteConfigError(`Option \`mode\` invalide : ${String(option)}.`);
    return option;
  }
  const ci = env["CI"]?.trim().toLowerCase();
  return ci && ci !== "false" && ci !== "0" ? "replay" : "auto";
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

async function readLimited(source: Request | Response, limit: number, what: string) {
  const declared = Number(source.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new CassetteError(
      `Corps de ${what} trop volumineux (> ${limit} octets, voir \`maxBodyBytes\`).`,
    );
  }
  const text = await source.text();
  if (Buffer.byteLength(text, "utf8") > limit) {
    throw new CassetteError(
      `Corps de ${what} trop volumineux (> ${limit} octets, voir \`maxBodyBytes\`).`,
    );
  }
  return text;
}

function replayResponse(it: Interaction): Response {
  const { status, statusText, headers, bodyEncoding, body } = it.response;
  const payload = NULL_BODY_STATUSES.has(status)
    ? null
    : bodyEncoding === "json"
      ? JSON.stringify(body)
      : (body as string);
  return new Response(payload, { status, ...(statusText ? { statusText } : {}), headers });
}

/**
 * Crée un `fetch` qui enregistre et rejoue les appels LLM dans une cassette JSON.
 * Compatible avec tout SDK qui accepte une option `fetch`.
 */
export function cassetteFetch(options: CassetteOptions): CassetteFetch {
  if (!options || typeof options.dir !== "string" || options.dir.trim() === "") {
    throw new CassetteConfigError("L'option `dir` est obligatoire.");
  }
  const mode = resolveMode(options.mode);
  const file = resolveCassettePath(options.dir, options.name ?? "default");
  const hosts = options.hosts ?? DEFAULT_HOSTS;
  const baseFetch = options.fetch ?? globalThis.fetch;
  if (typeof baseFetch !== "function") throw new CassetteConfigError("Aucun `fetch` disponible.");
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  if (!Number.isInteger(maxBody) || maxBody <= 0) {
    throw new CassetteConfigError("`maxBodyBytes` doit être un entier positif.");
  }
  const keyOptions: KeyOptions = { match: options.match, ignore: options.ignore };

  let cassette: Promise<Cassette> | undefined;
  const loadOnce = () => {
    cassette ??= (async () => {
      // En mode `record`, la cassette est réécrite depuis zéro.
      const existing = mode === "record" ? null : await loadCassette(file);
      return existing ?? { version: CASSETTE_VERSION, interactions: [] };
    })();
    return cassette;
  };
  const used = new Map<string, number>();
  let writes: Promise<void> = Promise.resolve();

  const f = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (mode === "passthrough" || !hostMatches(url.hostname, hosts)) {
      return baseFetch(input, init);
    }
    if (request.signal.aborted) throw abortError(request.signal);

    const bodyText = await readLimited(request.clone(), maxBody, "requête");
    const normalized = normalizeRequest(request.method, url, bodyText, keyOptions);
    const key = computeKey(normalized);
    const data = await loadOnce();

    // Les appels identiques sont rejoués dans l'ordre d'enregistrement.
    const index = used.get(key) ?? 0;
    const match = data.interactions.filter((it) => it.key === key)[index];
    if (match) {
      used.set(key, index + 1);
      return replayResponse(match);
    }

    const redactor = new Redactor(
      options.redact,
      Redactor.secretsFromHeaders(request.headers, options.redact?.headers),
    );
    if (mode === "replay") {
      throw describeMiss(normalized, data.interactions, keyOptions, file, redactor);
    }

    // Mode auto ou record : vrai appel réseau.
    const response = await baseFetch(request);
    const text = await readLimited(response.clone(), maxBody, "réponse");
    const transient = response.status === 429 || response.status >= 500;
    const recordable =
      response.status >= 200 && (!transient || options.recordTransientErrors === true);

    if (recordable) {
      const isJson = /\bjson\b/i.test(response.headers.get("content-type") ?? "");
      let resBody: JsonValue = text;
      if (isJson) {
        try {
          resBody = canonicalize(JSON.parse(text));
        } catch {
          resBody = text;
        }
      }
      const interaction: Interaction = {
        key,
        request: {
          method: normalized.method,
          url: redactor.maskString(redactUrl(url)),
          body: redactor.maskJson(parseBody(bodyText)),
        },
        response: {
          status: response.status,
          ...(response.statusText ? { statusText: response.statusText } : {}),
          headers: redactor.responseHeaders(response.headers),
          bodyEncoding: typeof resBody === "string" ? "text" : "json",
          body: redactor.maskJson(resBody),
        },
        recordedAt: new Date().toISOString(),
      };
      // Dernier filet avant écriture : aucun motif de secret ne doit subsister.
      redactor.assertNoSecrets({
        "request.url": interaction.request.url,
        "request.body": interaction.request.body,
        "response.headers": interaction.response.headers,
        "response.body": interaction.response.body,
      });
      data.interactions.push(interaction);
      used.set(key, index + 1);
      const snapshot: Cassette = {
        version: CASSETTE_VERSION,
        interactions: [...data.interactions],
      };
      writes = writes.then(() => saveCassette(file, snapshot));
      await writes;
    }
    return response;
  };

  return Object.assign(f, {
    mode,
    cassettePath: file,
    flush: () => writes,
  });
}
