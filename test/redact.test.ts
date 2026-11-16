import { describe, expect, it } from "vitest";
import { SecretDetectedError } from "../src/index.js";
import { REDACTED, Redactor } from "../src/redact.js";

const FAKE_OPENAI = `sk-proj-${"a1B2".repeat(10)}`;
const FAKE_ANTHROPIC = `sk-ant-api03-${"x9Y8".repeat(10)}`;
const FAKE_GOOGLE = `AIza${"Q".repeat(35)}`;

describe("Redactor", () => {
  it.each([FAKE_OPENAI, FAKE_ANTHROPIC, FAKE_GOOGLE, "AKIAABCDEFGHIJKLMNOP"])(
    "bloque l'écriture si un secret subsiste : %s",
    (secret) => {
      const r = new Redactor();
      expect(() => r.assertNoSecrets({ "response.body": { text: `voici ${secret}` } })).toThrow(
        SecretDetectedError,
      );
    },
  );

  it("le message d'erreur ne contient jamais le secret", () => {
    try {
      new Redactor().assertNoSecrets({ "request.body": { messages: [{ content: FAKE_OPENAI }] } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecretDetectedError);
      expect((err as Error).message).not.toContain(FAKE_OPENAI);
      expect((err as Error).message).toContain("request.body.messages[0].content");
    }
  });

  it("masque partout les valeurs des en-têtes d'authentification", () => {
    const headers = new Headers({ authorization: "Bearer my-very-long-mistral-key-123" });
    const r = new Redactor({}, Redactor.secretsFromHeaders(headers));
    expect(r.maskJson({ echo: "key=my-very-long-mistral-key-123" })).toEqual({
      echo: `key=${REDACTED}`,
    });
  });

  it("ne masque pas les valeurs courtes (clé factice de rejeu)", () => {
    const r = new Redactor({}, ["replay"]);
    expect(r.maskString("replay mode")).toBe("replay mode");
  });

  it("applique les motifs utilisateur, même sans drapeau g", () => {
    const r = new Redactor({ patterns: [/user-\d+/] });
    expect(r.maskString("user-1 et user-2")).toBe(`${REDACTED} et ${REDACTED}`);
  });

  it("ne garde que les en-têtes de réponse de la liste blanche", () => {
    const r = new Redactor({ keepResponseHeaders: ["x-custom"] });
    const out = r.responseHeaders(
      new Headers({
        "content-type": "application/json",
        "set-cookie": "session=abc",
        "openai-organization": "org-secret",
        "x-ratelimit-remaining-requests": "99",
        "x-custom": "ok",
      }),
    );
    expect(out).toEqual({
      "content-type": "application/json",
      "x-custom": "ok",
      "x-ratelimit-remaining-requests": "99",
    });
  });
});
