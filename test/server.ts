import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface FakeServer {
  url: string;
  hits: number;
  lastHeaders: IncomingHttpHeaders | undefined;
  /** Réponse(s) imposée(s) aux prochains appels, dans l'ordre. */
  queue: FakeReply[];
  close(): Promise<void>;
}

/** Faux serveur HTTP local qui imite les API OpenAI et Anthropic (non streaming). */
export async function startFakeServer(): Promise<FakeServer> {
  const state: Omit<FakeServer, "url" | "close"> = { hits: 0, lastHeaders: undefined, queue: [] };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      raw += c;
    });
    req.on("end", () => {
      state.hits++;
      state.lastHeaders = req.headers;
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const forced = state.queue.shift();
      let reply: FakeReply;
      if (forced) {
        reply = forced;
      } else if (req.url?.startsWith("/v1/chat/completions")) {
        reply = {
          body: {
            id: `chatcmpl-${state.hits}`,
            object: "chat.completion",
            created: 1_763_200_000,
            model: body["model"],
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: `réponse n°${state.hits}`, refusal: null },
                logprobs: null,
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          },
        };
      } else if (req.url?.startsWith("/v1/messages")) {
        reply = {
          body: {
            id: `msg_${state.hits}`,
            type: "message",
            role: "assistant",
            model: body["model"],
            content: [{ type: "text", text: `réponse n°${state.hits}` }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 3 },
          },
        };
      } else {
        reply = { status: 404, body: { error: "not found" } };
      }
      res.writeHead(reply.status ?? 200, {
        "content-type": "application/json",
        "x-request-id": `req_${state.hits}`,
        ...reply.headers,
      });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  });
}
