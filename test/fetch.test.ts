import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CassetteConfigError,
  CassetteMissError,
  type CassetteOptions,
  cassetteFetch,
  SecretDetectedError,
} from "../src/index.js";
import { LOCAL_HOSTS, readCassette, tempDir } from "./helpers.js";
import { type FakeServer, startFakeServer } from "./server.js";

let server: FakeServer;
let dir: string;

beforeEach(async () => {
  server = await startFakeServer();
  dir = await tempDir();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await server.close();
});

const make = (opts: Partial<CassetteOptions> = {}) =>
  cassetteFetch({ dir, name: "test", hosts: LOCAL_HOSTS, mode: "auto", ...opts });

const chat = (f: typeof fetch, content = "bonjour", apiKey = "sk-test-local-key-0000000000") =>
  f(`${server.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "gpt-x", messages: [{ role: "user", content }] }),
  });

describe("mode auto", () => {
  it("enregistre puis rejoue sans réseau", async () => {
    const first = await (await chat(make())).json();
    expect(server.hits).toBe(1);

    const second = await (await chat(make())).json();
    expect(server.hits).toBe(1);
    expect(second).toEqual(first);
  });

  it("rejoue les appels identiques dans l'ordre d'enregistrement", async () => {
    const rec = make();
    const a = await (await chat(rec)).json();
    const b = await (await chat(rec)).json();
    expect(a.id).not.toBe(b.id);

    const rep = make({ mode: "replay" });
    expect((await (await chat(rep)).json()).id).toBe(a.id);
    expect((await (await chat(rep)).json()).id).toBe(b.id);
    expect(server.hits).toBe(2);
  });

  it("n'enregistre pas les 429 et 5xx par défaut", async () => {
    server.queue.push({ status: 529, body: { type: "error" } });
    const f = make();
    expect((await chat(f)).status).toBe(529);
    expect(existsSync(f.cassettePath)).toBe(false);
  });
});

describe("mode replay", () => {
  it("échoue sans appel réseau si la cassette manque", async () => {
    await expect(chat(make({ mode: "replay" }))).rejects.toThrow(CassetteMissError);
    expect(server.hits).toBe(0);
  });

  it("montre le diff avec la requête la plus proche, sans fuite de clé", async () => {
    await chat(make(), "bonjour");
    const err = await chat(make({ mode: "replay" }), "au revoir").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CassetteMissError);
    const msg = (err as Error).message;
    expect(msg).toContain("messages[0].content");
    expect(msg).toContain('"bonjour"');
    expect(msg).toContain('"au revoir"');
    expect(msg).not.toContain("sk-test-local-key");
  });

  it("est le mode par défaut quand CI est défini", () => {
    vi.stubEnv("CI", "true");
    expect(cassetteFetch({ dir }).mode).toBe("replay");
  });
});

describe("modes record et passthrough", () => {
  it("record réécrit la cassette", async () => {
    await chat(make());
    await chat(make({ mode: "record" }));
    const { data } = await readCassette(make().cassettePath);
    expect(data.interactions).toHaveLength(1);
    expect(server.hits).toBe(2);
  });

  it("passthrough n'écrit rien", async () => {
    const f = make({ mode: "passthrough" });
    await chat(f);
    expect(existsSync(f.cassettePath)).toBe(false);
  });

  it("LLM_CASSETTE est prioritaire et validée", () => {
    vi.stubEnv("LLM_CASSETTE", "record");
    expect(make({ mode: "replay" }).mode).toBe("record");
    vi.stubEnv("LLM_CASSETTE", "n'importe-quoi");
    expect(() => make()).toThrow(CassetteConfigError);
  });

  it("laisse passer les hôtes non interceptés", async () => {
    const f = cassetteFetch({ dir, name: "test", mode: "replay" }); // hôtes par défaut
    expect((await chat(f)).status).toBe(200);
    expect(existsSync(f.cassettePath)).toBe(false);
  });
});

describe("sécurité des cassettes", () => {
  it("n'écrit ni en-têtes d'authentification, ni set-cookie, ni organisation", async () => {
    server.queue.push({
      headers: { "set-cookie": "sid=abc", "openai-organization": "org-123" },
      body: { ok: true },
    });
    const f = make();
    await chat(f, "bonjour", "sk-very-secret-value-1234567890");
    const { raw } = await readCassette(f.cassettePath);
    expect(raw).not.toContain("sk-very-secret-value");
    expect(raw).not.toContain("sid=abc");
    expect(raw).not.toContain("org-123");
    expect(raw).not.toMatch(/authorization/i);
  });

  it("masque la clé si l'API la renvoie en écho dans le corps", async () => {
    const apiKey = "mistral-style-key-without-prefix-42";
    server.queue.push({ body: { echo: `received ${apiKey}` } });
    const f = make();
    await chat(f, "bonjour", apiKey);
    const { raw } = await readCassette(f.cassettePath);
    expect(raw).not.toContain(apiKey);
    expect(raw).toContain("[REDACTED]");
  });

  it("refuse d'écrire si un motif de clé apparaît dans le prompt", async () => {
    const f = make();
    const leaked = `sk-ant-api03-${"Z".repeat(40)}`;
    await expect(chat(f, `ma clé est ${leaked}`)).rejects.toThrow(SecretDetectedError);
    expect(existsSync(f.cassettePath)).toBe(false);
  });

  it("refuse les noms de cassette qui sortent du dossier", () => {
    expect(() => make({ name: "../../etc/passwd" })).toThrow(CassetteConfigError);
  });

  it("refuse les corps de réponse trop volumineux", async () => {
    server.queue.push({ body: { big: "x".repeat(2048) } });
    await expect(chat(make({ maxBodyBytes: 1024 }))).rejects.toThrow(/trop volumineux/);
  });
});
