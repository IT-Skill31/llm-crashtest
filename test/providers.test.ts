import { createOpenAI } from "@ai-sdk/openai";
import { GoogleGenAI } from "@google/genai";
import { Mistral } from "@mistralai/mistralai";
import { HTTPClient } from "@mistralai/mistralai/lib/http.js";
import { generateText } from "ai";
import { CohereClientV2 } from "cohere-ai";
import { Ollama } from "ollama";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import {
  CassetteConfigError,
  type CassetteOptions,
  cassetteFetch,
  DEFAULT_HOSTS,
  ejectCassette,
  hostsFor,
  installGlobalFetch,
  SecretDetectedError,
  uninstallGlobalFetch,
  useCassette,
} from "../src/index.js";
import { errorFormatFor, hostMatches } from "../src/providers/index.js";
import { Redactor } from "../src/redact.js";
import { fakeLLMFetch, offlineFetch, WORDS } from "./fake-fetch.js";
import { readCassette, tempDir } from "./helpers.js";

describe("registre des fournisseurs", () => {
  it("intercepte les fournisseurs cloud par défaut, Ollama seulement sur demande", () => {
    expect(DEFAULT_HOSTS).toContain("api.groq.com");
    expect(DEFAULT_HOSTS).toContain("api.cohere.com");
    expect(DEFAULT_HOSTS).not.toContain("localhost");
    expect(hostsFor(["ollama"])).toContain("localhost");
  });

  it("refuse un fournisseur inconnu", () => {
    expect(() => cassetteFetch({ dir: "x", providers: ["nope"] })).toThrow(CassetteConfigError);
  });

  it("gère les jokers de domaine sans faux positif", () => {
    const vertex = ["*-aiplatform.googleapis.com"];
    expect(hostMatches("us-central1-aiplatform.googleapis.com", vertex)).toBe(true);
    expect(hostMatches("aiplatform.googleapis.com.evil.com", vertex)).toBe(false);
    expect(hostMatches("myres.openai.azure.com", ["*.openai.azure.com"])).toBe(true);
    expect(hostMatches("openai.azure.com", ["*.openai.azure.com"])).toBe(false);
  });

  it("choisit le format d'erreur du fournisseur", () => {
    expect(errorFormatFor(new URL("https://api.cohere.com/v2/chat"))).toBe("cohere");
    expect(errorFormatFor(new URL("http://localhost:11434/api/chat"))).toBe("ollama");
    expect(errorFormatFor(new URL("https://api.groq.com/openai/v1/chat/completions"))).toBe(
      "openai",
    );
    expect(errorFormatFor(new URL("https://x/v1beta/models/g:generateContent"))).toBe("gemini");
  });

  it.each([
    ["Groq", `gsk_${"a".repeat(48)}`],
    ["xAI", `xai-${"b".repeat(60)}`],
    ["Perplexity", `pplx-${"c".repeat(48)}`],
    ["Hugging Face", `hf_${"d".repeat(34)}`],
    ["OpenRouter", `sk-or-v1-${"e".repeat(64)}`],
    ["Vertex OAuth", `ya29.${"f".repeat(60)}`],
  ])("détecte une clé %s", (_name, key) => {
    expect(() => new Redactor().assertNoSecrets({ body: key })).toThrow(SecretDetectedError);
  });
});

/** Fournisseurs compatibles OpenAI : le SDK OpenAI avec un autre `baseURL`. */
const OPENAI_COMPATIBLE: [string, string][] = [
  ["Groq", "https://api.groq.com/openai/v1"],
  ["DeepSeek", "https://api.deepseek.com/v1"],
  ["xAI", "https://api.x.ai/v1"],
  ["OpenRouter", "https://openrouter.ai/api/v1"],
  ["Together", "https://api.together.xyz/v1"],
  ["Fireworks", "https://api.fireworks.ai/inference/v1"],
  ["Perplexity", "https://api.perplexity.ai"],
  ["Cerebras", "https://api.cerebras.ai/v1"],
  ["Hugging Face", "https://router.huggingface.co/v1"],
  ["Azure OpenAI", "https://myres.openai.azure.com/openai/v1"],
];

describe.each(OPENAI_COMPATIBLE)("%s (SDK OpenAI)", (_name, baseURL) => {
  const ask = (f: typeof fetch, maxRetries = 0) =>
    new OpenAI({ apiKey: "replay", baseURL, maxRetries, fetch: f }).chat.completions.create({
      model: "some-model",
      messages: [{ role: "user", content: "Bonjour" }],
    });

  it("enregistre puis rejoue hors ligne", async () => {
    const opts: CassetteOptions = { dir: await tempDir(), name: "c" };
    const live = await ask(cassetteFetch({ ...opts, mode: "auto", fetch: fakeLLMFetch() }));
    const replay = await ask(cassetteFetch({ ...opts, mode: "replay", fetch: offlineFetch }));
    expect(replay.choices[0]?.message.content).toBe(live.choices[0]?.message.content);
  });

  it("429 simulé : RateLimitError", async () => {
    const f = cassetteFetch({
      dir: await tempDir(),
      mode: "replay",
      fetch: offlineFetch,
      faults: [{ type: "http", status: 429 }],
    });
    await expect(ask(f)).rejects.toBeInstanceOf(OpenAI.RateLimitError);
  });
});

describe("autres SDK", () => {
  afterEach(async () => {
    await ejectCassette();
    uninstallGlobalFetch();
  });

  it("Gemini (@google/genai, sans option fetch) : mode global", async () => {
    const dir = await tempDir();
    installGlobalFetch(); // avant la création du client
    const ai = new GoogleGenAI({ apiKey: "replay" });
    const ask = () => ai.models.generateContent({ model: "gemini-x", contents: "Bonjour" });

    await useCassette("gemini", { dir, mode: "auto", fetch: fakeLLMFetch() });
    const live = await ask();
    await ejectCassette();

    await useCassette("gemini", { dir, mode: "replay", fetch: offlineFetch });
    expect((await ask()).text).toBe(live.text);
    expect(live.text).toBe("réponse de gemini-x");
  });

  it("Gemini en streaming SSE et panne 503", async () => {
    const dir = await tempDir();
    installGlobalFetch();
    const ai = new GoogleGenAI({ apiKey: "replay" });
    const stream = async () => {
      let text = "";
      for await (const c of await ai.models.generateContentStream({ model: "g", contents: "x" })) {
        text += c.text ?? "";
      }
      return text;
    };
    await useCassette("gs", { dir, mode: "auto", fetch: fakeLLMFetch() });
    expect(await stream()).toBe(WORDS.join(""));
    await ejectCassette();
    await useCassette("gs", { dir, mode: "replay", fetch: offlineFetch });
    expect(await stream()).toBe(WORDS.join(""));
    await ejectCassette();

    await useCassette("gs", {
      dir,
      mode: "replay",
      fetch: offlineFetch,
      faults: [{ type: "http", status: 503 }],
    });
    await expect(ai.models.generateContent({ model: "g", contents: "x" })).rejects.toThrow(
      /503|UNAVAILABLE|overloaded/i,
    );
  });

  it("Mistral (@mistralai/mistralai, HTTPClient)", async () => {
    const dir = await tempDir();
    const client = (f: typeof fetch) =>
      new Mistral({
        apiKey: "replay",
        httpClient: new HTTPClient({ fetcher: f }),
        retryConfig: { strategy: "none" },
      });
    const ask = (f: typeof fetch) =>
      client(f).chat.complete({
        model: "mistral-small",
        messages: [{ role: "user", content: "Bonjour" }],
      });
    const live = await ask(cassetteFetch({ dir, name: "m", mode: "auto", fetch: fakeLLMFetch() }));
    const replay = await ask(
      cassetteFetch({ dir, name: "m", mode: "replay", fetch: offlineFetch }),
    );
    expect(replay.choices?.[0]?.message?.content).toBe(live.choices?.[0]?.message?.content);
    expect(live.choices?.[0]?.message?.content).toBe("réponse de mistral-small");
  });

  it("Cohere (cohere-ai v2, option fetch)", async () => {
    const dir = await tempDir();
    const ask = (f: typeof fetch) =>
      new CohereClientV2({ token: "replay", fetch: f }).chat({
        model: "command-x",
        messages: [{ role: "user", content: "Bonjour" }],
      });
    const live = await ask(cassetteFetch({ dir, name: "co", mode: "auto", fetch: fakeLLMFetch() }));
    const replay = await ask(
      cassetteFetch({ dir, name: "co", mode: "replay", fetch: offlineFetch }),
    );
    expect(replay.message.content).toEqual(live.message.content);
  });

  it("Ollama (local, NDJSON) : opt-in via providers", async () => {
    const dir = await tempDir();
    const opts: CassetteOptions = { dir, name: "ol", providers: ["ollama"] };
    const chat = async (f: typeof fetch) => {
      const ollama = new Ollama({ host: "http://localhost:11434", fetch: f });
      let text = "";
      for await (const part of await ollama.chat({
        model: "llama-x",
        messages: [{ role: "user", content: "Bonjour" }],
        stream: true,
      })) {
        text += part.message.content;
      }
      return text;
    };
    const recorder = cassetteFetch({ ...opts, mode: "auto", fetch: fakeLLMFetch() });
    expect(await chat(recorder)).toBe(WORDS.join(""));
    // Le SDK Ollama s'arrête sur `done: true` sans lire la fin du flux : l'enregistrement
    // continue en arrière-plan, `flush()` l'attend.
    await recorder.flush();
    const { data } = await readCassette(recorder.cassettePath);
    expect(data.interactions[0]?.response.bodyEncoding).toBe("stream");
    expect(await chat(cassetteFetch({ ...opts, mode: "replay", fetch: offlineFetch }))).toBe(
      WORDS.join(""),
    );

    // Panne au milieu du flux NDJSON
    const cut = cassetteFetch({
      ...opts,
      mode: "replay",
      fetch: offlineFetch,
      faults: [{ type: "stream-cut", afterChunks: 2 }],
    });
    await expect(chat(cut)).rejects.toThrow();
  });

  it("Vercel AI SDK (@ai-sdk/openai, option fetch)", async () => {
    const dir = await tempDir();
    const ask = (f: typeof fetch) =>
      generateText({
        model: createOpenAI({ apiKey: "replay", fetch: f }).chat("gpt-x"),
        prompt: "Bonjour",
        maxRetries: 0,
      });
    const live = await ask(cassetteFetch({ dir, name: "ai", mode: "auto", fetch: fakeLLMFetch() }));
    const replay = await ask(
      cassetteFetch({ dir, name: "ai", mode: "replay", fetch: offlineFetch }),
    );
    expect(replay.text).toBe(live.text);
    expect(live.text).toBe("réponse de gpt-x");
  });
});
