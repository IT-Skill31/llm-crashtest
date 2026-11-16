import { CassetteConfigError } from "./errors.js";
import { isPlainObject, type JsonValue } from "./json.js";
import { sleep } from "./stream.js";

/** N-ième appel intercepté (à partir de 1), ou filtre. Absent : tous les appels. */
export type FaultTarget = number | { call?: number; model?: string };

interface FaultBase {
  on?: FaultTarget;
}
export interface HttpFault extends FaultBase {
  type: "http";
  status: number;
  /** En-tête `retry-after`, en secondes. */
  retryAfter?: number;
  /** En-tête `x-should-retry`, lu par les SDK OpenAI et Anthropic. */
  shouldRetry?: boolean;
  /** Corps d'erreur personnalisé. Par défaut : un vrai format d'erreur du fournisseur. */
  body?: JsonValue;
}
export interface TimeoutFault extends FaultBase {
  type: "timeout";
  /** Délai avant l'échec, en ms. Par défaut 0. */
  afterMs?: number;
}
export interface StreamCutFault extends FaultBase {
  type: "stream-cut";
  /** Nombre de chunks transmis avant la coupure. */
  afterChunks: number;
}
export interface MalformedFault extends FaultBase {
  type: "malformed";
  /** Index du chunk SSE corrompu (par défaut 0). Sans flux, le JSON est tronqué. */
  chunk?: number;
}
export interface LatencyFault extends FaultBase {
  type: "latency";
  ms: number;
}
export type Fault = HttpFault | TimeoutFault | StreamCutFault | MalformedFault | LatencyFault;

const MAX_DELAY_MS = 5 * 60 * 1000;

function nonNegInt(v: unknown, max = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
}

/** Valide la configuration des pannes (données venant du code de test, mais typées à l'exécution). */
export function validateFaults(faults: unknown): Fault[] {
  if (faults === undefined) return [];
  if (!Array.isArray(faults)) throw new CassetteConfigError("`faults` doit être un tableau.");
  return faults.map((f: unknown, i): Fault => {
    const bad = (why: string): never => {
      throw new CassetteConfigError(`faults[${i}] invalide : ${why}`);
    };
    if (!isPlainObject(f)) return bad("objet attendu");
    const on = f["on"];
    if (on !== undefined) {
      const ok =
        (Number.isInteger(on) && (on as number) >= 1) ||
        (isPlainObject(on) &&
          (on["call"] === undefined ||
            (Number.isInteger(on["call"]) && (on["call"] as number) >= 1)) &&
          (on["model"] === undefined || typeof on["model"] === "string"));
      if (!ok) bad("`on` doit être un entier ≥ 1 ou { call?, model? }");
    }
    switch (f["type"]) {
      case "http":
        if (
          !Number.isInteger(f["status"]) ||
          (f["status"] as number) < 400 ||
          (f["status"] as number) > 599
        ) {
          bad("`status` doit être entre 400 et 599");
        }
        if (f["retryAfter"] !== undefined && !nonNegInt(f["retryAfter"], 86_400))
          bad("`retryAfter` invalide");
        break;
      case "timeout":
        if (f["afterMs"] !== undefined && !nonNegInt(f["afterMs"], MAX_DELAY_MS))
          bad("`afterMs` invalide");
        break;
      case "stream-cut":
        if (!nonNegInt(f["afterChunks"])) bad("`afterChunks` doit être un entier ≥ 0");
        break;
      case "malformed":
        if (f["chunk"] !== undefined && !nonNegInt(f["chunk"])) bad("`chunk` invalide");
        break;
      case "latency":
        if (!nonNegInt(f["ms"], MAX_DELAY_MS)) bad("`ms` invalide");
        break;
      default:
        bad("`type` doit être http, timeout, stream-cut, malformed ou latency");
    }
    return f as unknown as Fault;
  });
}

export function faultsFor(faults: readonly Fault[], call: number, body: JsonValue): Fault[] {
  const model =
    isPlainObject(body) && typeof body["model"] === "string" ? body["model"] : undefined;
  return faults.filter(({ on }) => {
    if (on === undefined) return true;
    if (typeof on === "number") return on === call;
    return (
      (on.call === undefined || on.call === call) && (on.model === undefined || on.model === model)
    );
  });
}

type ProviderKind = "anthropic" | "openai" | "gemini" | "mistral";

export function detectProvider(url: URL): ProviderKind {
  const h = url.hostname;
  if (h === "api.anthropic.com" || url.pathname.endsWith("/v1/messages")) return "anthropic";
  if (
    h.endsWith("generativelanguage.googleapis.com") ||
    /:(stream)?generateContent$/i.test(url.pathname)
  ) {
    return "gemini";
  }
  if (h === "api.mistral.ai") return "mistral";
  return "openai";
}

const ANTHROPIC_TYPES: Record<number, [string, string]> = {
  400: ["invalid_request_error", "Invalid request"],
  401: ["authentication_error", "invalid x-api-key"],
  403: ["permission_error", "Permission denied"],
  404: ["not_found_error", "Not found"],
  413: ["request_too_large", "Request exceeds the maximum allowed number of bytes."],
  429: ["rate_limit_error", "Rate limit exceeded"],
  500: ["api_error", "Internal server error"],
  529: ["overloaded_error", "Overloaded"],
};
const GEMINI_STATUS: Record<number, [string, string]> = {
  400: ["INVALID_ARGUMENT", "Request contains an invalid argument."],
  403: ["PERMISSION_DENIED", "Permission denied."],
  404: ["NOT_FOUND", "Requested entity was not found."],
  429: ["RESOURCE_EXHAUSTED", "Resource has been exhausted (e.g. check quota)."],
  500: ["INTERNAL", "An internal error has occurred."],
  503: ["UNAVAILABLE", "The model is overloaded. Please try again later."],
  504: ["DEADLINE_EXCEEDED", "Deadline exceeded."],
};

/** Corps d'erreur au format réel de chaque fournisseur, pour que le SDK lève la bonne exception. */
export function providerErrorBody(provider: ProviderKind, status: number): JsonValue {
  switch (provider) {
    case "anthropic": {
      const [type, message] = ANTHROPIC_TYPES[status] ??
        (status >= 500 ? ANTHROPIC_TYPES[500] : ANTHROPIC_TYPES[400]) ?? ["api_error", "Error"];
      return { type: "error", error: { type, message } };
    }
    case "gemini": {
      const [s, message] = GEMINI_STATUS[status] ??
        (status >= 500 ? GEMINI_STATUS[500] : GEMINI_STATUS[400]) ?? ["UNKNOWN", "Error"];
      return { error: { code: status, message, status: s } };
    }
    default: {
      const rate = status === 429;
      const body = {
        message: rate
          ? "Rate limit reached for requests"
          : status >= 500
            ? "The server had an error while processing your request."
            : "Invalid request",
        type: rate ? "requests" : status >= 500 ? "server_error" : "invalid_request_error",
        param: null,
        code: rate ? "rate_limit_exceeded" : null,
      };
      return provider === "mistral" ? { object: "error", ...body } : { error: body };
    }
  }
}

export function httpFaultResponse(fault: HttpFault, url: URL): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-request-id": "req_llm_crashtest_fault",
  };
  if (fault.retryAfter !== undefined) headers["retry-after"] = String(fault.retryAfter);
  if (fault.shouldRetry !== undefined) headers["x-should-retry"] = String(fault.shouldRetry);
  const body = fault.body ?? providerErrorBody(detectProvider(url), fault.status);
  return new Response(JSON.stringify(body), { status: fault.status, headers });
}

/** Échec comme un délai dépassé : `AbortError`, que les SDK traduisent en erreur de timeout. */
export async function timeoutFault(fault: TimeoutFault, signal: AbortSignal): Promise<never> {
  await sleep(fault.afterMs ?? 0, signal);
  throw new DOMException("The operation timed out (llm-crashtest fault)", "AbortError");
}

export async function latencyFaults(faults: readonly Fault[], signal: AbortSignal): Promise<void> {
  for (const f of faults) if (f.type === "latency") await sleep(f.ms, signal);
}

const MALFORMED_SSE = 'data: {"llm-crashtest": malformed\n\n';

/**
 * Garde les lignes `event:` (sinon certains SDK ignorent l'événement) et tronque le JSON
 * des lignes `data:` : le parseur du SDK reçoit un événement connu mais illisible.
 */
export function corruptSseChunk(chunk: string): string {
  let touched = false;
  const out = chunk.replace(/^data: ?(.+)$/gm, (_line, payload: string) => {
    touched = true;
    return `data: ${payload.slice(0, Math.max(1, Math.floor(payload.length / 2)))}`;
  });
  return touched ? out : `${chunk}${MALFORMED_SSE}`;
}

/** Applique `stream-cut` et `malformed` au corps d'une réponse rejouée. */
export async function applyBodyFaults(
  response: Response,
  faults: readonly Fault[],
  streaming: boolean,
): Promise<Response> {
  const cut = faults.find((f): f is StreamCutFault => f.type === "stream-cut");
  const malformed = faults.find((f): f is MalformedFault => f.type === "malformed");
  if ((!cut && !malformed) || !response.body) return response;
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  };

  if (malformed && !streaming) {
    const text = await response.text();
    return applyBodyFaults(
      new Response(text.slice(0, Math.floor(text.length / 2)), init),
      cut ? [cut] : [],
      false,
    );
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let index = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (cut && index >= cut.afterChunks) {
          // Même erreur qu'undici quand la connexion se ferme au milieu du corps.
          controller.error(
            new TypeError("terminated", { cause: new Error("llm-crashtest stream-cut") }),
          );
          return;
        }
        controller.enqueue(
          malformed && index === (malformed.chunk ?? 0)
            ? encoder.encode(corruptSseChunk(decoder.decode(chunk)))
            : chunk,
        );
        index++;
      },
      flush() {
        if (cut && index >= cut.afterChunks) {
          throw new TypeError("terminated", { cause: new Error("llm-crashtest stream-cut") });
        }
      },
    }),
  );
  return new Response(body, init);
}
