import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli/index.js";
import { escapeMd, isSafeRef, renderReport } from "../src/cli/report.js";
import type { Cassette } from "../src/index.js";
import { toTraceEntries, writeTrace } from "../src/trace.js";
import { tempDir } from "./helpers.js";

const key = (n: number) => `sha256:${String(n).padStart(64, "0")}`;

function cassette(text: string, ...keys: number[]): Cassette {
  return {
    version: 1,
    interactions: keys.map((k) => ({
      key: key(k),
      request: {
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        body: { model: "gpt-x" },
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        bodyEncoding: "json",
        body: { choices: [{ message: { role: "assistant", content: text } }] },
      },
      recordedAt: "2026-11-17T00:00:00Z",
    })),
  };
}

async function project() {
  const cwd = await tempDir();
  const dir = path.join(cwd, "tests", "__cassettes__");
  await mkdir(dir, { recursive: true });
  const write = (name: string, c: Cassette) =>
    writeFile(path.join(dir, name), `${JSON.stringify(c, null, 2)}\n`);
  const out: string[] = [];
  const io = { log: (l: string) => out.push(l), error: (l: string) => out.push(`ERR ${l}`) };
  const run = (...args: string[]) => main(args, io, cwd);
  return { cwd, dir, write, out, run };
}

describe("CLI prune / stale / rerecord", () => {
  it("sans trace : explique quoi faire", async () => {
    const p = await project();
    expect(await p.run("prune")).toBe(2);
    expect(p.out.join("\n")).toMatch(/Aucune trace/);
  });

  it("prune liste sans supprimer, puis supprime avec --yes", async () => {
    const p = await project();
    await p.write("used.json", cassette("a", 1));
    await p.write("orphan.json", cassette("b", 2));
    await writeFile(path.join(p.dir, "notes.json"), "{ pas une cassette");
    await writeTrace(
      toTraceEntries(
        [
          {
            cassettePath: path.join(p.dir, "used.json"),
            usedKeys: [key(1)],
            knownKeys: [key(1)],
            misses: 0,
            calls: 1,
          },
        ],
        p.cwd,
      ),
      p.cwd,
    );

    expect(await p.run("prune")).toBe(0);
    expect(existsSync(path.join(p.dir, "orphan.json"))).toBe(true);
    expect(p.out.join("\n")).toMatch(/orphan\.json/);

    expect(await p.run("prune", "--yes")).toBe(0);
    expect(existsSync(path.join(p.dir, "orphan.json"))).toBe(false);
    expect(existsSync(path.join(p.dir, "used.json"))).toBe(true);
    expect(existsSync(path.join(p.dir, "notes.json"))).toBe(true); // jamais supprimé : invalide
  });

  it("stale --check signale les interactions jamais rejouées, rerecord les supprime", async () => {
    const p = await project();
    await p.write("chat.json", cassette("a", 1, 2));
    await writeTrace(
      toTraceEntries(
        [
          {
            cassettePath: path.join(p.dir, "chat.json"),
            usedKeys: [key(1)],
            knownKeys: [key(1), key(2)],
            misses: 0,
            calls: 1,
          },
        ],
        p.cwd,
      ),
      p.cwd,
    );
    expect(await p.run("stale", "--check")).toBe(1);
    expect(p.out.join("\n")).toMatch(/chat\.json.*1 interaction/);

    expect(await p.run("rerecord")).toBe(2); // --stale obligatoire
    expect(await p.run("rerecord", "--stale")).toBe(0);
    expect(existsSync(path.join(p.dir, "chat.json"))).toBe(false);
  });

  it("refuse les options inconnues", async () => {
    const p = await project();
    expect(await p.run("prune", "--force-everything")).toBe(2);
  });
});

describe("CLI report", () => {
  it("refuse les références git dangereuses", () => {
    expect(isSafeRef("origin/main")).toBe(true);
    expect(isSafeRef("HEAD~1")).toBe(true);
    expect(isSafeRef("--upload-pack=evil")).toBe(false);
    expect(isSafeRef("-x")).toBe(false);
    expect(isSafeRef("main..evil")).toBe(false);
    expect(isSafeRef("a b")).toBe(false);
  });

  it("échappe le contenu des cassettes (HTML, tableaux, mentions)", () => {
    const out = escapeMd("<img src=x onerror=alert(1)> | @admin `code` [lien](http://x)");
    expect(out).not.toMatch(/<img/);
    expect(out).not.toMatch(/(^|[^\\])\|/);
    expect(out).not.toMatch(/@admin/);
    expect(out).not.toContain("`");
  });

  it("résume ajouts, suppressions et réponses modifiées", () => {
    const md = renderReport(
      [
        {
          file: "t/a.json",
          status: "modified",
          before: cassette("Paris", 1),
          after: cassette("Lyon", 1),
        },
        { file: "t/b.json", status: "added", before: null, after: cassette("x", 2) },
      ],
      "main",
    );
    expect(md).toMatch(/1 ajoutée\(s\), 1 modifiée\(s\), 0 supprimée\(s\)/);
    expect(md).toMatch(/avant : Paris/);
    expect(md).toMatch(/après : Lyon/);
  });

  // Plusieurs appels git : lent sous Windows quand les tests tournent en parallèle.
  it("compare avec une branche git réelle", { timeout: 30_000 }, async () => {
    const p = await project();
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: p.cwd, stdio: "pipe", encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    git("config", "commit.gpgsign", "false");
    await p.write("chat.json", cassette("Paris", 1));
    git("add", ".");
    git("commit", "-q", "-m", "init");
    await p.write("chat.json", cassette("Lyon", 1));
    await p.write("new.json", cassette("x", 3));

    expect(await p.run("report", "--base", "main")).toBe(0);
    const md = p.out.join("\n");
    expect(md).toMatch(/tests\/__cassettes__\/chat\.json/);
    expect(md).toMatch(/1 ajoutée\(s\), 1 modifiée\(s\)/);
    expect(await p.run("report", "--base", "--output=/etc/x")).toBe(2);
  });
});
