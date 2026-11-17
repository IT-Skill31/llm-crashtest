import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

const MAX_FILES = 20_000;
const MAX_DEPTH = 32;

/**
 * Liste les fichiers `.json` du dossier des cassettes. Ne suit pas les liens symboliques
 * et ignore les dossiers cachés : la CLI ne peut rien lire ni supprimer hors de `dir`.
 */
export async function listCassetteFiles(dir: string): Promise<string[]> {
  const root = path.resolve(dir);
  const out: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(current, e.name);
      const st = await lstat(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) await walk(full, depth + 1);
      else if (st.isFile() && e.name.endsWith(".json")) {
        out.push(full);
        if (out.length > MAX_FILES) throw new Error(`Plus de ${MAX_FILES} cassettes : abandon.`);
      }
    }
  };
  await walk(root, 0);
  return out.sort();
}

export function isInside(root: string, file: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export const display = (file: string, cwd = process.cwd()) =>
  path.relative(cwd, file).split(path.sep).join("/");
