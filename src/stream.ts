import { CassetteError } from "./errors.js";
import type { Redactor } from "./redact.js";
import type { StreamChunk } from "./store.js";

export type ReplayTiming = "instant" | "original";

export function isEventStream(headers: Headers): boolean {
  return /^text\/event-stream\b/i.test(headers.get("content-type") ?? "");
}

function tooBig(limit: number): CassetteError {
  return new CassetteError(
    `Flux de réponse trop volumineux (> ${limit} octets, voir \`maxBodyBytes\`).`,
  );
}

/** Accumule les chunks avec leur délai relatif, en texte brut (les octets SSE d'origine). */
class ChunkRecorder {
  readonly chunks: StreamChunk[] = [];
  readonly #start = performance.now();
  readonly #decoder = new TextDecoder("utf-8", { fatal: false });
  #bytes = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Uint8Array): void {
    this.#bytes += chunk.byteLength;
    if (this.#bytes > this.limit) throw tooBig(this.limit);
    const data = this.#decoder.decode(chunk, { stream: true });
    if (data !== "") this.chunks.push({ t: Math.round(performance.now() - this.#start), data });
  }

  end(): StreamChunk[] {
    const rest = this.#decoder.decode();
    if (rest !== "")
      this.chunks.push({ t: Math.round(performance.now() - this.#start), data: rest });
    return this.chunks;
  }
}

/**
 * Flux transmis au SDK pendant l'enregistrement : chaque chunk est relayé tel quel et noté.
 * À la fin, `onComplete` écrit la cassette ; s'il échoue (secret détecté…), le flux se termine
 * en erreur côté SDK et rien n'est écrit (échec en mode sûr, OWASP A10).
 */
export function recordingStream(
  body: ReadableStream<Uint8Array>,
  limit: number,
  onComplete: (chunks: StreamChunk[]) => Promise<void>,
): ReadableStream<Uint8Array> {
  const recorder = new ChunkRecorder(limit);
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        recorder.push(chunk);
        controller.enqueue(chunk);
      },
      async flush() {
        await onComplete(recorder.end());
      },
    }),
  );
}

/** Lit un flux en entier en conservant le découpage et le timing. */
export async function captureStream(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<StreamChunk[]> {
  const recorder = new ChunkRecorder(limit);
  if (!body) return recorder.end();
  for await (const chunk of body) recorder.push(chunk);
  return recorder.end();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export { sleep };

/** Réémet les chunks enregistrés, instantanément ou au timing d'origine. */
export function replayStream(
  chunks: readonly StreamChunk[],
  timing: ReplayTiming,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const start = performance.now();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = chunks[i++];
      if (!chunk) return controller.close();
      if (timing === "original") {
        const wait = chunk.t - (performance.now() - start);
        if (wait > 0) await sleep(wait, signal);
      }
      controller.enqueue(encoder.encode(chunk.data));
    },
  });
}

/**
 * Masque chaque chunk. Si un secret est coupé entre deux chunks, le masquage par chunk le
 * manquerait : dans ce cas, les chunks sont fusionnés en un seul (sûreté avant fidélité).
 */
export function maskChunks(chunks: readonly StreamChunk[], redactor: Redactor): StreamChunk[] {
  const masked = chunks.map((c) => ({ t: c.t, data: redactor.maskString(c.data) }));
  const whole = redactor.maskString(chunks.map((c) => c.data).join(""));
  if (masked.map((c) => c.data).join("") === whole) return masked;
  return [{ t: chunks.at(-1)?.t ?? 0, data: whole }];
}
