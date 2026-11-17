/**
 * Une petite « application » qui appelle plusieurs LLM. C'est le code testé par les exemples :
 * il doit rester utilisable quand l'API tombe (quota, surcharge, timeout).
 */

import { createOpenAI } from "@ai-sdk/openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { generateText } from "ai";
import { Ollama } from "ollama";
import OpenAI from "openai";

// Clients créés au chargement du module : le plugin les intercepte quand même.
const anthropic = new Anthropic({
  apiKey: process.env["ANTHROPIC_API_KEY"] ?? "replay",
  maxRetries: 0,
});
const openai = new OpenAI({ apiKey: process.env["OPENAI_API_KEY"] ?? "replay", maxRetries: 0 });
const groq = new OpenAI({
  apiKey: process.env["GROQ_API_KEY"] ?? "replay",
  baseURL: "https://api.groq.com/openai/v1",
  maxRetries: 0,
  timeout: 2_000,
});
const gemini = new GoogleGenAI({ apiKey: process.env["GEMINI_API_KEY"] ?? "replay" });
const ollama = new Ollama({ host: "http://localhost:11434" });

/** Résumé par Claude ; si l'API est surchargée, repli sur un résumé extractif local. */
export async function summarize(
  text: string,
): Promise<{ source: "llm" | "fallback"; summary: string }> {
  try {
    const r = await anthropic.messages.create({
      model: "claude-sonnet-5-5",
      max_tokens: 200,
      messages: [{ role: "user", content: `Résume : ${text}` }],
    });
    const block = r.content[0];
    return { source: "llm", summary: block?.type === "text" ? block.text : "" };
  } catch (err) {
    if (err instanceof Anthropic.APIError && (err.status === 529 || err.status === 503)) {
      return { source: "fallback", summary: `${text.split(". ")[0]}.` };
    }
    throw err;
  }
}

/** Chat OpenAI avec un message clair pour l'utilisateur en cas de quota dépassé. */
export async function chat(question: string): Promise<string> {
  try {
    const r = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: question }],
    });
    return r.choices[0]?.message.content ?? "";
  } catch (err) {
    if (err instanceof OpenAI.RateLimitError) {
      const wait = err.headers?.get("retry-after");
      return `Trop de demandes, réessayez dans ${wait ?? "quelques"} secondes.`;
    }
    throw err;
  }
}

/** Classification rapide via Groq ; au-delà du délai, réponse par défaut. */
export async function classify(message: string): Promise<string> {
  try {
    const r = await groq.chat.completions.create({
      model: "llama-4-scout",
      messages: [{ role: "user", content: `Catégorie de : ${message}` }],
    });
    return r.choices[0]?.message.content ?? "autre";
  } catch (err) {
    if (err instanceof OpenAI.APIConnectionTimeoutError) return "autre";
    throw err;
  }
}

/** Traduction via Gemini (SDK sans option `fetch`) ; texte d'origine si indisponible. */
export async function translate(text: string): Promise<string> {
  try {
    const r = await gemini.models.generateContent({
      model: "gemini-3-flash",
      contents: `Traduis : ${text}`,
    });
    return r.text ?? text;
  } catch {
    return text;
  }
}

/** Assistant local Ollama ; message d'aide si le serveur local ne répond pas. */
export async function localAssistant(prompt: string): Promise<string> {
  try {
    const r = await ollama.chat({
      model: "llama3.3",
      messages: [{ role: "user", content: prompt }],
    });
    return r.message.content;
  } catch {
    return "Le modèle local est indisponible. Lancez `ollama serve`.";
  }
}

/** Même appel via le Vercel AI SDK, qui fait ses propres retries. */
export async function aiSdkAnswer(prompt: string, fetchImpl?: typeof fetch): Promise<string> {
  const provider = createOpenAI({
    apiKey: process.env["OPENAI_API_KEY"] ?? "replay",
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const r = await generateText({ model: provider.chat("gpt-5-mini"), prompt, maxRetries: 1 });
  return r.text;
}
