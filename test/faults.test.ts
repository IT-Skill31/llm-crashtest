import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { providerErrorBody } from "../src/faults.js";
import { CassetteConfigError, type CassetteOptions, cassetteFetch } from "../src/index.js";
import { fakeLLMFetch, offlineFetch, WORDS } from "./fake-fetch.js";
import { tempDir } from "./helpers.js";

/** Code applicatif testé : bascule sur un modèle de secours si le principal est surchargé. */
async function summarize(client: Anthropic): Promise<{ model: string; text: string }> {
  const ask = async (model: string) => {
    const r = await client.messages.create({
      model,
      max_tokens: 64,
      messages: [{ role: "user", content: "Résume cet article" }],
    });
    const b = r.content[0];
    return { model: r.model, text: b?.type === "text" ? b.text : "" };
  };
  try {
    return await ask("claude-main");
  } catch (err) {
    if (err instanceof Anthropic.APIError && err.status === 529) return ask("claude-fallback");
    throw err;
  }
}

const anthropic = (fetch: typeof globalThis.fetch, maxRetries = 0) =>
  new Anthropic({ apiKey: "replay", maxRetries, fetch });

describe("pannes HTTP", () => {
  it("529 sur le premier appel : l'app bascule sur le modèle de secours (puis rejeu hors ligne)", async () => {
    const dir = await tempDir();
    const opts: CassetteOptions = {
      dir,
      name: "fallback",
      faults: [{ on: 1, type: "http", status: 529 }],
    };
    const live = fakeLLMFetch();
    const first = await summarize(anthropic(cassetteFetch({ ...opts, mode: "auto", fetch: live })));
    expect(first.model).toBe("claude-fallback");
    expect(live.hits).toBe(1); // le 529 n'a pas touché le réseau

    const replay = await summarize(
      anthropic(cassetteFetch({ ...opts, mode: "replay", fetch: offlineFetch })),
    );
    expect(replay).toEqual(first);
  });

  it("le SDK lève la bonne classe d'erreur avec le vrai corps du fournisseur", async () => {
    const f = cassetteFetch({
      dir: await tempDir(),
      mode: "auto",
      fetch: fakeLLMFetch(),
      faults: [{ type: "http", status: 529 }],
    });
    const err = await anthropic(f)
      .messages.create({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "x" }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.APIError);
    expect((err as InstanceType<typeof Anthropic.APIError>).status).toBe(529);
    expect(JSON.stringify((err as InstanceType<typeof Anthropic.APIError>).error)).toContain(
      "overloaded_error",
    );
  });

  it("429 avec retry-after : le SDK réessaie et le 2e appel est rejoué", async () => {
    const dir = await tempDir();
    await (async () => {
      const f = cassetteFetch({ dir, name: "retry", mode: "auto", fetch: fakeLLMFetch() });
      await new OpenAI({ apiKey: "replay", fetch: f }).chat.completions.create({
        model: "gpt-x",
        messages: [{ role: "user", content: "x" }],
      });
    })();
    const f = cassetteFetch({
      dir,
      name: "retry",
      mode: "replay",
      fetch: offlineFetch,
      faults: [{ on: 1, type: "http", status: 429, retryAfter: 0 }],
    });
    const r = await new OpenAI({
      apiKey: "replay",
      maxRetries: 1,
      fetch: f,
    }).chat.completions.create({
      model: "gpt-x",
      messages: [{ role: "user", content: "x" }],
    });
    expect(r.choices[0]?.message.content).toBe("réponse de gpt-x");
    expect(f.calls).toBe(2);
  });

  it("OpenAI : 429 donne une RateLimitError", async () => {
    const f = cassetteFetch({
      dir: await tempDir(),
      mode: "replay",
      fetch: offlineFetch,
      faults: [{ type: "http", status: 429 }],
    });
    const err = await new OpenAI({ apiKey: "replay", maxRetries: 0, fetch: f }).chat.completions
      .create({ model: "gpt-x", messages: [{ role: "user", content: "x" }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAI.RateLimitError);
  });

  it("produit le format d'erreur Gemini", () => {
    expect(providerErrorBody("gemini", 429)).toEqual({
      error: { code: 429, message: expect.any(String), status: "RESOURCE_EXHAUSTED" },
    });
  });

  it("filtre par modèle", async () => {
    const f = cassetteFetch({
      dir: await tempDir(),
      mode: "auto",
      fetch: fakeLLMFetch(),
      faults: [{ on: { model: "claude-main" }, type: "http", status: 529 }],
    });
    expect((await summarize(anthropic(f))).model).toBe("claude-fallback");
  });
});

describe("pannes de transport et de flux", () => {
  async function recordStream(dir: string) {
    const f = cassetteFetch({ dir, name: "s", mode: "auto", fetch: fakeLLMFetch() });
    const s = anthropic(f).messages.stream({
      model: "m",
      max_tokens: 9,
      messages: [{ role: "user", content: "x" }],
    });
    await s.finalMessage();
  }
  const streamText = async (f: typeof fetch) => {
    let text = "";
    try {
      const s = anthropic(f).messages.stream({
        model: "m",
        max_tokens: 9,
        messages: [{ role: "user", content: "x" }],
      });
      for await (const ev of s) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta")
          text += ev.delta.text;
      }
      return { text, error: undefined };
    } catch (error) {
      return { text, error };
    }
  };

  it("stream-cut : le texte partiel arrive, puis le flux échoue", async () => {
    const dir = await tempDir();
    await recordStream(dir);
    const f = cassetteFetch({
      dir,
      name: "s",
      mode: "replay",
      fetch: offlineFetch,
      faults: [{ type: "stream-cut", afterChunks: 4 }], // start, block_start, 2 deltas
    });
    const { text, error } = await streamText(f);
    expect(text).toBe(WORDS.slice(0, 2).join(""));
    expect(error).toBeDefined();
  });

  it("stream-cut sur un appel réel : la cassette reste intacte", async () => {
    const dir = await tempDir();
    const f = cassetteFetch({
      dir,
      name: "s",
      mode: "auto",
      fetch: fakeLLMFetch(),
      faults: [{ type: "stream-cut", afterChunks: 3 }],
    });
    expect((await streamText(f)).error).toBeDefined();
    const clean = await streamText(
      cassetteFetch({ dir, name: "s", mode: "replay", fetch: offlineFetch }),
    );
    expect(clean).toEqual({ text: WORDS.join(""), error: undefined });
  });

  it("malformed : le parseur du SDK échoue", async () => {
    const dir = await tempDir();
    await recordStream(dir);
    const f = cassetteFetch({
      dir,
      name: "s",
      mode: "replay",
      fetch: offlineFetch,
      faults: [{ type: "malformed", chunk: 2 }],
    });
    expect((await streamText(f)).error).toBeDefined();
  });

  it("timeout : le SDK lève une erreur de timeout sans réseau", async () => {
    const f = cassetteFetch({
      dir: await tempDir(),
      mode: "replay",
      fetch: offlineFetch,
      faults: [{ type: "timeout", afterMs: 10 }],
    });
    const err = await anthropic(f)
      .messages.create({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "x" }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
  });

  it("latency : ajoute le délai demandé", async () => {
    const dir = await tempDir();
    await recordStream(dir);
    const f = cassetteFetch({
      dir,
      name: "s",
      mode: "replay",
      fetch: offlineFetch,
      faults: [{ type: "latency", ms: 120 }],
    });
    const t = performance.now();
    await streamText(f);
    expect(performance.now() - t).toBeGreaterThanOrEqual(110);
  });

  it("setFaults remplace les pannes et remet le compteur à zéro", async () => {
    const f = cassetteFetch({
      dir: await tempDir(),
      mode: "auto",
      fetch: fakeLLMFetch(),
      faults: [{ type: "http", status: 500 }],
    });
    const create = () =>
      anthropic(f).messages.create({
        model: "m",
        max_tokens: 1,
        messages: [{ role: "user", content: "x" }],
      });
    await expect(create()).rejects.toBeInstanceOf(Anthropic.InternalServerError);
    f.setFaults([]);
    expect(f.calls).toBe(0);
    await expect(create()).resolves.toBeDefined();
  });

  it.each([
    [{ type: "nope" }],
    [{ type: "http", status: 200 }],
    [{ type: "stream-cut" }],
    [{ type: "latency", ms: -1 }],
    [{ type: "http", status: 500, on: 0 }],
  ])("rejette une panne invalide : %j", (fault) => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: test d'entrée invalide
      cassetteFetch({ dir: "x", faults: [fault as any] }),
    ).toThrow(CassetteConfigError);
  });
});
