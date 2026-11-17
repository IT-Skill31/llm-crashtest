import OpenAI from "openai";
import { describe, expect, test } from "vitest";
import { useCassette } from "../../../dist/index.js";

// Client créé au chargement du module, avant les hooks : il doit quand même être intercepté.
const client = new OpenAI({
  apiKey: "sk-e2e-local-key-000000000000",
  baseURL: `${process.env["E2E_BASE_URL"]}/v1`,
  maxRetries: 0,
});

const ask = (content: string) =>
  client.chat.completions.create({ model: "gpt-e2e", messages: [{ role: "user", content }] });

describe("chat", () => {
  test("répond", async () => {
    const r = await ask("Bonjour");
    expect(r.choices[0]?.message.content).toMatch(/^réponse n°/);
  });

  test("deux appels identiques rejoués dans l'ordre", async () => {
    const a = await ask("Encore");
    const b = await ask("Encore");
    expect(a.id).not.toBe(b.id);
  });
});

test("panne 529 avec useCassette", async () => {
  await useCassette("custom/overloaded", { faults: [{ type: "http", status: 529 }] });
  await expect(ask("Bonjour")).rejects.toMatchObject({ status: 529 });
});
