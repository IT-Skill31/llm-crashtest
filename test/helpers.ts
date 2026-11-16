import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import type { Cassette } from "../src/index.js";

const ROOT = path.resolve(import.meta.dirname, ".tmp");

export async function tempDir(): Promise<string> {
  await mkdir(ROOT, { recursive: true });
  return mkdtemp(path.join(ROOT, "run-"));
}

export async function readCassette(file: string): Promise<{ raw: string; data: Cassette }> {
  const raw = await readFile(file, "utf8");
  return { raw, data: JSON.parse(raw) as Cassette };
}

export const LOCAL_HOSTS = ["127.0.0.1"];
