import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { cassetteFetch } from "../src/index.js";
import { LOCAL_HOSTS, tempDir } from "./helpers.js";
import { startFakeServer } from "./server.js";

/**
 * Jalon v0.2 : un test OpenAI et un test Anthropic passent hors ligne en mode `replay`.
 * Enregistrement contre le faux serveur, puis serveur arrêté et rejeu dans le vrai SDK.
 */
describe("intégration SDK (non streaming)", () => {
  it("OpenAI : enregistre puis rejoue hors ligne", async () => {
    const dir = await tempDir();
    const server = await startFakeServer();
    const ask = async (mode: "auto" | "replay") => {
      const client = new OpenAI({
        apiKey: "sk-test-local-key-0000000000",
        baseURL: `${server.url}/v1`,
        maxRetries: 0,
        fetch: cassetteFetch({ dir, name: "openai", mode, hosts: LOCAL_HOSTS }),
      });
      const r = await client.chat.completions.create({
        model: "gpt-x",
        messages: [{ role: "user", content: "Dis bonjour" }],
      });
      return r.choices[0]?.message.content;
    };

    const recorded = await ask("auto");
    await server.close();
    expect(await ask("replay")).toBe(recorded);
  });

  it("Anthropic : enregistre puis rejoue hors ligne", async () => {
    const dir = await tempDir();
    const server = await startFakeServer();
    const ask = async (mode: "auto" | "replay") => {
      const client = new Anthropic({
        apiKey: mode === "replay" ? "replay" : "sk-ant-test-local-0000000000",
        baseURL: server.url,
        maxRetries: 0,
        fetch: cassetteFetch({ dir, name: "anthropic", mode, hosts: LOCAL_HOSTS }),
      });
      const r = await client.messages.create({
        model: "claude-x",
        max_tokens: 64,
        messages: [{ role: "user", content: "Dis bonjour" }],
      });
      const block = r.content[0];
      return block?.type === "text" ? block.text : undefined;
    };

    const recorded = await ask("auto");
    expect(recorded).toBeTruthy();
    await server.close();
    expect(await ask("replay")).toBe(recorded);
  });
});
