/**
 * Faux `fetch` qui imite OpenAI et Anthropic, en JSON ou en SSE.
 * Chaque événement SSE est émis comme un chunk distinct, ce qui rend les tests déterministes.
 */
export interface FakeFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  hits: number;
}

export const WORDS = ["Bon", "jour", " le", " monde"];

const sse = (event: string | null, data: unknown) =>
  `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;

function anthropicEvents(model: string, words: string[], extra: string): string[] {
  return [
    sse("message_start", {
      type: "message_start",
      message: {
        id: "msg_stream",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    }),
    sse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    ...[...words, ...(extra ? [extra] : [])].map((text) =>
      sse("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      }),
    ),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ];
}

function openaiEvents(model: string, words: string[], extra: string): string[] {
  const chunk = (delta: object, finish: string | null) =>
    sse(null, {
      id: "chatcmpl-stream",
      object: "chat.completion.chunk",
      created: 1_763_200_000,
      model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    });
  return [
    chunk({ role: "assistant", content: "" }, null),
    ...[...words, ...(extra ? [extra] : [])].map((content) => chunk({ content }, null)),
    chunk({}, "stop"),
    sse(null, "[DONE]"),
  ];
}

const json = (data: unknown, hits: number) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json", "request-id": `req_${hits}` },
  });

function streamOf(events: string[], contentType: string, delayMs?: number): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const ev = events[i++];
      if (ev === undefined) return controller.close();
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      controller.enqueue(encoder.encode(ev));
    },
  });
  return new Response(stream, { headers: { "content-type": contentType } });
}

/** Gemini (generateContent / streamGenerateContent?alt=sse), Cohere v2 et Ollama. */
function otherProviders(url: URL, body: Record<string, unknown>, hits: number): Response | null {
  const gemini = /\/models\/([^/:]+):(stream)?[gG]enerateContent$/.exec(url.pathname);
  if (gemini) {
    const model = gemini[1];
    const candidate = (text: string, done: boolean) => ({
      candidates: [
        {
          content: { role: "model", parts: [{ text }] },
          ...(done ? { finishReason: "STOP" } : {}),
          index: 0,
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
      modelVersion: model,
    });
    if (gemini[2]) {
      const events = WORDS.map(
        (w, i) => `data: ${JSON.stringify(candidate(w, i === WORDS.length - 1))}\r\n\r\n`,
      );
      return streamOf(events, "text/event-stream");
    }
    return json(candidate(`réponse de ${model}`, true), hits);
  }
  if (url.pathname === "/v2/chat") {
    return json(
      {
        id: `cohere-${hits}`,
        finish_reason: "COMPLETE",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `réponse de ${body["model"]}` }],
        },
        usage: {
          billed_units: { input_tokens: 5, output_tokens: 3 },
          tokens: { input_tokens: 5, output_tokens: 3 },
        },
      },
      hits,
    );
  }
  if (url.pathname === "/api/chat") {
    const base = { model: body["model"], created_at: "2026-11-17T10:00:00Z" };
    if (body["stream"] !== false) {
      const lines = [
        ...WORDS.map(
          (w) =>
            `${JSON.stringify({ ...base, message: { role: "assistant", content: w }, done: false })}\n`,
        ),
        `${JSON.stringify({ ...base, message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: 4 })}\n`,
      ];
      return streamOf(lines, "application/x-ndjson");
    }
    return json(
      {
        ...base,
        message: { role: "assistant", content: `réponse de ${body["model"]}` },
        done: true,
        done_reason: "stop",
        eval_count: 3,
      },
      hits,
    );
  }
  return null;
}

export function fakeLLMFetch(opts: { delayMs?: number; extraText?: string } = {}): FakeFetch {
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    f.hits++;
    const req = new Request(input, init);
    const body = JSON.parse(await req.text()) as { model: string; stream?: boolean };
    const url = new URL(req.url);
    const other = otherProviders(url, body as unknown as Record<string, unknown>, f.hits);
    if (other) return other;
    const anthropic = url.pathname.endsWith("/v1/messages");
    const extra = opts.extraText ?? "";

    if (!body.stream) {
      const json = anthropic
        ? {
            id: `msg_${f.hits}`,
            type: "message",
            role: "assistant",
            model: body.model,
            content: [{ type: "text", text: `réponse de ${body.model}` }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 3 },
          }
        : {
            id: `chatcmpl-${f.hits}`,
            object: "chat.completion",
            created: 1_763_200_000,
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: `réponse de ${body.model}`, refusal: null },
                logprobs: null,
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          };
      return new Response(JSON.stringify(json), {
        headers: { "content-type": "application/json", "request-id": `req_${f.hits}` },
      });
    }

    const events = anthropic
      ? anthropicEvents(body.model, WORDS, extra)
      : openaiEvents(body.model, WORDS, extra);
    const encoder = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const ev = events[i++];
        if (ev === undefined) return controller.close();
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        controller.enqueue(encoder.encode(ev));
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  }) as FakeFetch;
  f.hits = 0;
  return f;
}

/** `fetch` qui échoue : prouve qu'un test rejoué n'a fait aucun appel réseau. */
export const offlineFetch = (() => {
  throw new Error("réseau interdit pendant le rejeu");
}) as unknown as typeof fetch;
