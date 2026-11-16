import { describeMiss } from "./diff.js";
import { CassetteConfigError, CassetteError } from "./errors.js";
import {
  applyBodyFaults,
  type Fault,
  faultsFor,
  httpFaultResponse,
  latencyFaults,
  timeoutFault,
  validateFaults,
} from "./faults.js";
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
  type StreamChunk,
  saveCassette,
} from "./store.js";
import {
  captureStream,
  isEventStream,
  maskChunks,
  type ReplayTiming,
  recordingStream,
  replayStream,
} from "./stream.js";

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
  /** Pannes injectées, appliquées sans réseau. Voir `setFaults` pour les changer en cours de test. */
  faults?: readonly Fault[];
  /** Rejeu des flux SSE : `instant` (par défaut) ou `original` (délais d'enregistrement). */
  replayTiming?: ReplayTiming;
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
  /** Nombre d'appels interceptés depuis la création ou le dernier `setFaults`. */
  readonly calls: number;
  /** Remplace les pannes injectées et remet le compteur d'appels à zéro. */
  setFaults(faults?: readonly Fault[]): void;
  /** Attend la fin des écritures de cassette en cours. */
  flush(): Promise<void>;
}

const DEFAULT_MAX_BODY = 10 * 1024 * 1024;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
/** En-têtes qui ne décrivent plus le corps une fois décodé par `fetch`. */
const STALE_HEADERS = ["content-encoding", "content-length", "transfer-encoding"];

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

function tooBig(what: string, limit: number): CassetteError {
  return new CassetteError(
    `Corps de ${what} trop volumineux (> ${limit} octets, voir \`maxBodyBytes\`).`,
  );
}

async function readLimited(source: Request | Response, limit: number, what: string) {
  const declared = Number(source.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw tooBig(what, limit);
  const text = await source.text();
  if (Buffer.byteLength(text, "utf8") > limit) throw tooBig(what, limit);
  return text;
}

function freshHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const h of STALE_HEADERS) out.delete(h);
  return out;
}

function replayResponse(it: Interaction, timing: ReplayTiming, signal: AbortSignal): Response {
  const { status, statusText, headers, bodyEncoding, body } = it.response;
  let payload: BodyInit | null = null;
  if (!NULL_BODY_STATUSES.has(status)) {
    if (bodyEncoding === "stream") payload = replayStream(it.stream ?? [], timing, signal);
    else payload = bodyEncoding === "json" ? JSON.stringify(body) : (body as string);
  }
  return new Response(payload, { status, ...(statusText ? { statusText } : {}), headers });
}

/**
 * Crée un `fetch` qui enregistre et rejoue les appels LLM dans une cassette JSON,
 * et qui peut y injecter des pannes. Compatible avec tout SDK qui accepte une option `fetch`.
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
  const timing = options.replayTiming ?? "instant";
  if (timing !== "instant" && timing !== "original") {
    throw new CassetteConfigError("`replayTiming` doit valoir `instant` ou `original`.");
  }
  const keyOptions: KeyOptions = { match: options.match, ignore: options.ignore };
  let faults = validateFaults(options.faults);
  let calls = 0;

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

  const persist = async (data: Cassette, interaction: Interaction) => {
    data.interactions.push(interaction);
    const snapshot: Cassette = { version: CASSETTE_VERSION, interactions: [...data.interactions] };
    writes = writes.then(() => saveCassette(file, snapshot));
    await writes;
  };

  const f = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (mode === "passthrough" || !hostMatches(url.hostname, hosts)) {
      return baseFetch(input, init);
    }
    if (request.signal.aborted) throw abortError(request.signal);
    const call = ++calls;

    const bodyText = await readLimited(request.clone(), maxBody, "requête");
    const normalized = normalizeRequest(request.method, url, bodyText, keyOptions);
    const active = faultsFor(faults, call, parseBody(bodyText));

    // Pannes « avant réponse » : aucune interaction consommée, aucun réseau.
    const http = active.find((x) => x.type === "http");
    if (http) return httpFaultResponse(http, url);
    const timeout = active.find((x) => x.type === "timeout");
    if (timeout) return timeoutFault(timeout, request.signal);
    await latencyFaults(active, request.signal);
    const bodyFaulted = active.some((x) => x.type === "stream-cut" || x.type === "malformed");

    const key = computeKey(normalized);
    const data = await loadOnce();

    // Les appels identiques sont rejoués dans l'ordre d'enregistrement.
    const index = used.get(key) ?? 0;
    const match = data.interactions.filter((it) => it.key === key)[index];
    if (match) {
      used.set(key, index + 1);
      const res = replayResponse(match, timing, request.signal);
      return applyBodyFaults(res, active, match.response.bodyEncoding === "stream");
    }

    const redactor = new Redactor(
      options.redact,
      Redactor.secretsFromHeaders(request.headers, options.redact?.headers),
    );
    if (mode === "replay") {
      throw describeMiss(normalized, data.interactions, keyOptions, file, redactor);
    }
    used.set(key, index + 1);

    // Mode auto ou record : vrai appel réseau.
    const response = await baseFetch(request);
    const transient = response.status === 429 || response.status >= 500;
    const recordable =
      response.status >= 200 && (!transient || options.recordTransientErrors === true);
    const streaming = isEventStream(response.headers) && response.body !== null;

    const build = (resBody: JsonValue, stream?: StreamChunk[]): Interaction => {
      const encoding = stream ? "stream" : typeof resBody === "string" ? "text" : "json";
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
          bodyEncoding: encoding,
          body: stream ? null : redactor.maskJson(resBody),
        },
        ...(stream ? { stream: maskChunks(stream, redactor) } : {}),
        recordedAt: new Date().toISOString(),
      };
      // Dernier filet avant écriture : aucun motif de secret ne doit subsister.
      redactor.assertNoSecrets({
        "request.url": interaction.request.url,
        "request.body": interaction.request.body,
        "response.headers": interaction.response.headers,
        "response.body": interaction.response.body,
        "response.stream": (interaction.stream ?? []).map((c) => c.data).join(""),
      });
      return interaction;
    };

    if (!recordable) {
      used.set(key, index); // rien d'enregistré : la place réservée est libérée
      return response;
    }

    if (streaming && !bodyFaulted) {
      // Le SDK reçoit le flux en direct ; la cassette est écrite quand le flux se termine.
      const body = recordingStream(response.body as ReadableStream<Uint8Array>, maxBody, (chunks) =>
        persist(data, build(null, chunks)),
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: freshHeaders(response.headers),
      });
    }

    let interaction: Interaction;
    if (streaming) {
      // Panne de corps demandée sur un appel réel : on enregistre le flux intact, puis on rejoue
      // la version enregistrée avec la panne (la cassette n'est jamais corrompue).
      interaction = build(null, await captureStream(response.body, maxBody));
    } else {
      const text = await readLimited(response, maxBody, "réponse");
      let resBody: JsonValue = text;
      if (/\bjson\b/i.test(response.headers.get("content-type") ?? "")) {
        try {
          resBody = canonicalize(JSON.parse(text));
        } catch {
          resBody = text;
        }
      }
      interaction = build(resBody);
      if (!bodyFaulted) {
        await persist(data, interaction);
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: freshHeaders(response.headers),
        });
      }
    }
    await persist(data, interaction);
    const res = replayResponse(interaction, timing, request.signal);
    return applyBodyFaults(res, active, streaming);
  };

  return Object.defineProperties(f, {
    mode: { value: mode, enumerable: true },
    cassettePath: { value: file, enumerable: true },
    calls: { get: () => calls, enumerable: true },
    setFaults: {
      value: (next?: readonly Fault[]) => {
        faults = validateFaults(next);
        calls = 0;
      },
    },
    flush: { value: () => writes },
  }) as CassetteFetch;
}
