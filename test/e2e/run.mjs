// Test de bout en bout du package compilé (dist/) : plugin Vitest réel + CLI.
// Usage : npm run build && npm run test:e2e
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const fixture = path.join(here, "vitest-plugin");
const cassettes = path.join(fixture, "__cassettes__");
const require = createRequire(import.meta.url);
const vitestBin = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const cliBin = path.join(root, "dist", "cli.js");

function step(name) {
  console.log(`\n▶ ${name}`);
}

/** Asynchrone : le faux serveur tourne dans ce processus et doit pouvoir répondre. */
function run(args, env, cwd = fixture) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, CI: "", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** Faux serveur OpenAI minimal (chat completions, non streaming). */
function startServer() {
  let hits = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      hits++;
      const { model } = JSON.parse(body || "{}");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${hits}`,
          object: "chat.completion",
          created: 1_763_200_000,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `réponse n°${hits}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        hits: () => hits,
        close: () => server.close(),
      }),
    ),
  );
}

assert.ok(existsSync(cliBin), "dist/ absent : lancez npm run build");
rmSync(cassettes, { recursive: true, force: true });
rmSync(path.join(fixture, "node_modules"), { recursive: true, force: true });

step("1. Enregistrement (LLM_CASSETTE=auto) contre le faux serveur");
const server = await startServer();
let r = await run([vitestBin, "run"], { LLM_CASSETTE: "auto", E2E_BASE_URL: server.url });
server.close();
assert.equal(r.code, 0, r.out);
assert.equal(server.hits(), 3, "3 appels réels attendus (la panne 529 ne touche pas le réseau)");
const first = path.join(cassettes, "chat.e2e", "chat", "répond.json");
assert.ok(existsSync(first), `cassette attendue : ${first}`);
assert.ok(!readFileSync(first, "utf8").includes("sk-e2e"), "la clé API ne doit pas être écrite");

step("2. Rejeu hors ligne (LLM_CASSETTE=replay, serveur arrêté)");
r = await run([vitestBin, "run"], { LLM_CASSETTE: "replay", E2E_BASE_URL: "http://127.0.0.1:9" });
assert.equal(r.code, 0, r.out);

step("3. CLI stale : aucune cassette périmée");
r = await run([cliBin, "stale", "--dir", "__cassettes__", "--check"], {});
assert.equal(r.code, 0, r.out);
assert.match(r.out, /Aucune cassette périmée/);

step("4. CLI prune : une cassette orpheline est détectée");
const orphan = path.join(cassettes, "orphan.json");
writeFileSync(orphan, JSON.stringify({ version: 1, interactions: [] }));
r = await run([cliBin, "prune", "--dir", "__cassettes__"], {});
assert.equal(r.code, 0, r.out);
assert.match(r.out, /orphan\.json/);
assert.ok(existsSync(orphan), "prune sans --yes ne supprime rien");
r = await run([cliBin, "prune", "--dir", "__cassettes__", "--yes"], {});
assert.equal(r.code, 0, r.out);
assert.ok(!existsSync(orphan), "prune --yes supprime l'orpheline");
assert.ok(existsSync(first), "prune --yes garde les cassettes utilisées");

rmSync(cassettes, { recursive: true, force: true });
rmSync(path.join(fixture, "node_modules"), { recursive: true, force: true });
console.log("\n✅ e2e OK");
