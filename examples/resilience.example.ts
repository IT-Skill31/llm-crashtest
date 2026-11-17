/**
 * Exemples exécutables sans clé API ni réseau : chaque test simule une panne réelle
 * d'un fournisseur et vérifie que l'application réagit correctement.
 *
 *   npm run build && npm run examples
 */
import { cassetteFetch, useCassette } from "@appystore/llm-crashtest";
import { describe, expect, test } from "vitest";
import { aiSdkAnswer, chat, classify, localAssistant, summarize, translate } from "./app.js";

describe("Anthropic", () => {
  test("surcharge (529) : repli sur un résumé local", async () => {
    await useCassette("anthropic/overloaded", { faults: [{ type: "http", status: 529 }] });
    const r = await summarize("Le chat dort. Il fait beau. Le chien aboie.");
    expect(r).toEqual({ source: "fallback", summary: "Le chat dort." });
  });
});

describe("OpenAI", () => {
  test("quota dépassé (429 + retry-after) : message clair", async () => {
    await useCassette("openai/rate-limited", {
      faults: [{ type: "http", status: 429, retryAfter: 20 }],
    });
    expect(await chat("Bonjour")).toBe("Trop de demandes, réessayez dans 20 secondes.");
  });
});

describe("Groq (compatible OpenAI)", () => {
  test("timeout : catégorie par défaut", async () => {
    await useCassette("groq/timeout", { faults: [{ type: "timeout" }] });
    expect(await classify("Ma commande n'est pas arrivée")).toBe("autre");
  });
});

describe("Gemini (SDK sans option fetch)", () => {
  test("indisponible (503) : texte d'origine conservé", async () => {
    await useCassette("gemini/unavailable", { faults: [{ type: "http", status: 503 }] });
    expect(await translate("Bonjour")).toBe("Bonjour");
  });
});

describe("Ollama (local)", () => {
  test("serveur local en erreur : message d'aide", async () => {
    await useCassette("ollama/down", {
      providers: ["ollama"],
      faults: [{ type: "http", status: 500 }],
    });
    expect(await localAssistant("Salut")).toMatch(/ollama serve/);
  });
});

describe("Vercel AI SDK", () => {
  test("429 persistant : le SDK abandonne après ses retries", async () => {
    const f = cassetteFetch({
      dir: "examples/__cassettes__",
      name: "ai-sdk/rate-limited",
      faults: [{ type: "http", status: 429, retryAfter: 0 }],
    });
    await expect(aiSdkAnswer("Bonjour", f)).rejects.toThrow();
    expect(f.calls).toBe(2); // 1 appel + 1 retry, aucun n'a touché le réseau
  });
});
