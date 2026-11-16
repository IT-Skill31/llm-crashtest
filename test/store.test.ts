import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CassetteConfigError, CassetteFormatError } from "../src/index.js";
import { loadCassette, resolveCassettePath } from "../src/store.js";
import { tempDir } from "./helpers.js";

describe("chemin des cassettes", () => {
  const dir = path.resolve("cassettes");

  it("reste dans le dossier et accepte les sous-dossiers", () => {
    expect(resolveCassettePath(dir, "chat/résumé article")).toBe(
      path.join(dir, "chat", "résumé article.json"),
    );
  });

  it.each(["../evil", "a/../../evil", "..", "", "   "])("refuse %j", (name) => {
    expect(() => resolveCassettePath(dir, name)).toThrow(CassetteConfigError);
  });

  it("neutralise les chemins absolus et caractères spéciaux", () => {
    const p = resolveCassettePath(dir, "C:\\Windows\\x<y>:z");
    expect(path.relative(dir, p).startsWith("..")).toBe(false);
    expect(path.basename(p)).toBe("x_y__z.json");
  });

  it("évite les noms réservés Windows", () => {
    expect(path.basename(resolveCassettePath(dir, "con"))).toBe("_con.json");
  });
});

describe("lecture des cassettes", () => {
  it("renvoie null si le fichier n'existe pas", async () => {
    expect(await loadCassette(path.join(await tempDir(), "absent.json"))).toBeNull();
  });

  it.each([
    ["JSON illisible", "{"],
    ["version inconnue", JSON.stringify({ version: 99, interactions: [] })],
    ["interaction invalide", JSON.stringify({ version: 1, interactions: [{ key: "x" }] })],
    [
      "flux sans chunks",
      JSON.stringify({
        version: 1,
        interactions: [
          {
            key: `sha256:${"0".repeat(64)}`,
            request: { method: "POST", url: "https://h/x", body: null },
            response: { status: 200, headers: {}, bodyEncoding: "stream", body: null },
            stream: [{ t: -1, data: 42 }],
            recordedAt: "2026-11-15T00:00:00Z",
          },
        ],
      }),
    ],
  ])("rejette : %s", async (_label, content) => {
    const file = path.join(await tempDir(), "bad.json");
    await writeFile(file, content);
    await expect(loadCassette(file)).rejects.toThrow(CassetteFormatError);
  });
});
