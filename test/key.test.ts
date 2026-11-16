import { describe, expect, it } from "vitest";
import { computeKey, normalizeRequest, redactUrl, selectBody } from "../src/key.js";

const key = (url: string, body: unknown, opts = {}) =>
  computeKey(normalizeRequest("post", new URL(url), JSON.stringify(body), opts));

describe("clé de cassette", () => {
  it("ne dépend pas de l'ordre des clés JSON", () => {
    expect(key("https://api.openai.com/v1/x", { a: 1, b: { c: 2, d: 3 } })).toBe(
      key("https://api.openai.com/v1/x", { b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("change si le corps, le chemin ou l'hôte change", () => {
    const base = key("https://api.openai.com/v1/x", { a: 1 });
    expect(key("https://api.openai.com/v1/x", { a: 2 })).not.toBe(base);
    expect(key("https://api.openai.com/v1/y", { a: 1 })).not.toBe(base);
    expect(key("https://api.anthropic.com/v1/x", { a: 1 })).not.toBe(base);
  });

  it("ignore le port et les paramètres d'URL secrets", () => {
    expect(key("http://127.0.0.1:1111/v1/x?key=AAA", { a: 1 })).toBe(
      key("http://127.0.0.1:2222/v1/x?key=BBB", { a: 1 }),
    );
  });

  it("applique match et ignore (avec joker)", () => {
    const opts = { ignore: ["metadata.ts", "messages.*.id"] };
    const a = key(
      "https://h/x",
      { metadata: { ts: 1, u: "x" }, messages: [{ id: 1, t: "a" }] },
      opts,
    );
    const b = key(
      "https://h/x",
      { metadata: { ts: 2, u: "x" }, messages: [{ id: 9, t: "a" }] },
      opts,
    );
    expect(a).toBe(b);
    expect(selectBody({ model: "m", user: "u" }, { match: ["model"] })).toEqual({ model: "m" });
  });

  it("une clé __proto__ dans le corps ne pollue pas les prototypes", () => {
    normalizeRequest("POST", new URL("https://h/x"), '{"__proto__":{"polluted":true}}', {});
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("masque les identifiants dans l'URL stockée", () => {
    const out = redactUrl(
      new URL("https://u:p@generativelanguage.googleapis.com/v1/m?key=AIzaSECRET&alt=sse"),
    );
    expect(out).not.toContain("AIzaSECRET");
    expect(out).not.toContain("u:p@");
    expect(out).toContain("alt=sse");
  });
});
