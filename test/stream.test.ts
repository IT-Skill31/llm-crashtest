import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { type CassetteOptions, cassetteFetch } from "../src/index.js";
import { Redactor } from "../src/redact.js";
import { maskChunks } from "../src/stream.js";
import { fakeLLMFetch, offlineFetch, WORDS } from "./fake-fetch.js";
import { readCassette, tempDir } from "./helpers.js";

const FULL = WORDS.join("");

async function anthropicStream(fetch: typeof globalThis.fetch): Promise<string> {
  const client = new Anthropic({ apiKey: "replay", maxRetries: 0, fetch });
  let text = "";
  const stream = client.messages.stream({
    model: "claude-x",
    max_tokens: 64,
    messages: [{ role: "user", content: "Salue le monde" }],
  });
  for await (const ev of stream) {
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") text += ev.delta.text;
  }
  return text;
}

async function openaiStream(fetch: typeof globalThis.fetch): Promise<string> {
  const client = new OpenAI({ apiKey: "replay", maxRetries: 0, fetch });
  const stream = await client.chat.completions.create({
    model: "gpt-x",
    stream: true,
    messages: [{ role: "user", content: "Salue le monde" }],
  });
  let text = "";
  for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? "";
  return text;
}

describe("streaming SSE", () => {
  it("Anthropic : enregistre chunk par chunk puis rejoue hors ligne", async () => {
    const dir = await tempDir();
    const opts: CassetteOptions = { dir, name: "a-stream" };
    const live = fakeLLMFetch();
    expect(await anthropicStream(cassetteFetch({ ...opts, mode: "auto", fetch: live }))).toBe(FULL);

    const { data } = await readCassette(cassetteFetch(opts).cassettePath);
    const it0 = data.interactions[0];
    expect(it0?.response.bodyEncoding).toBe("stream");
    expect(it0?.stream?.length).toBe(9); // un chunk par événement SSE
    expect(it0?.stream?.[0]?.data).toMatch(/^event: message_start\n/);

    const replay = cassetteFetch({ ...opts, mode: "replay", fetch: offlineFetch });
    expect(await anthropicStream(replay)).toBe(FULL);
  });

  it("OpenAI : enregistre puis rejoue hors ligne", async () => {
    const dir = await tempDir();
    const opts: CassetteOptions = { dir, name: "o-stream" };
    expect(
      await openaiStream(cassetteFetch({ ...opts, mode: "auto", fetch: fakeLLMFetch() })),
    ).toBe(FULL);
    const replay = cassetteFetch({ ...opts, mode: "replay", fetch: offlineFetch });
    expect(await openaiStream(replay)).toBe(FULL);
  });

  it("rejoue au timing d'origine si demandé", async () => {
    const dir = await tempDir();
    const opts: CassetteOptions = { dir, name: "timing" };
    await openaiStream(
      cassetteFetch({ ...opts, mode: "auto", fetch: fakeLLMFetch({ delayMs: 40 }) }),
    );

    let t = performance.now();
    await openaiStream(cassetteFetch({ ...opts, mode: "replay", fetch: offlineFetch }));
    const instant = performance.now() - t;

    t = performance.now();
    await openaiStream(
      cassetteFetch({ ...opts, mode: "replay", fetch: offlineFetch, replayTiming: "original" }),
    );
    const original = performance.now() - t;
    expect(original).toBeGreaterThan(150); // 7 chunks × 40 ms enregistrés
    expect(original).toBeGreaterThan(instant);
  });

  it("refuse d'écrire un flux qui contient un secret, et le SDK reçoit une erreur", async () => {
    const dir = await tempDir();
    const leaked = `sk-ant-api03-${"K".repeat(40)}`;
    const f = cassetteFetch({
      dir,
      name: "leak",
      mode: "auto",
      fetch: fakeLLMFetch({ extraText: leaked }),
    });
    const err = await anthropicStream(f).catch((e: unknown) => e);
    expect(String(err)).toMatch(/secret probable/);
    expect(String(err)).not.toContain(leaked);
    expect(existsSync(f.cassettePath)).toBe(false);
  });

  it("fusionne les chunks si un secret est coupé entre deux chunks", () => {
    const secret = "my-very-long-mistral-key-123456";
    const r = new Redactor({}, [secret]);
    const out = maskChunks(
      [
        { t: 0, data: `data: ${secret.slice(0, 10)}` },
        { t: 5, data: `${secret.slice(10)}\n\n` },
      ],
      r,
    );
    expect(out).toEqual([{ t: 5, data: "data: [REDACTED]\n\n" }]);
  });
});
