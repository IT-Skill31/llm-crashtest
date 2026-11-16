export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Copie profonde avec clés triées. Utilise `Object.fromEntries` (CreateDataProperty),
 * ce qui empêche qu'une clé `__proto__` venue d'un JSON modifie un prototype.
 */
export function canonicalize(value: unknown): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return Object.fromEntries(
      keys.filter((k) => value[k] !== undefined).map((k) => [k, canonicalize(value[k])]),
    );
  }
  return null;
}

/** Parcourt toutes les chaînes d'une valeur JSON et renvoie une copie transformée. */
export function mapStrings(
  value: JsonValue,
  fn: (s: string, path: string) => string,
  path = "",
): JsonValue {
  if (typeof value === "string") return fn(value, path);
  if (Array.isArray(value)) return value.map((v, i) => mapStrings(v, fn, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn, path ? `${path}.${k}` : k)]),
    );
  }
  return value;
}

/** Aplatit une valeur JSON en `{ chemin: valeur }` pour comparer deux corps. */
export function flatten(value: JsonValue, path = "", out = new Map<string, string>()) {
  if (Array.isArray(value)) {
    if (value.length === 0) out.set(path, "[]");
    value.forEach((v, i) => {
      flatten(v, `${path}[${i}]`, out);
    });
  } else if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) out.set(path, "{}");
    for (const [k, v] of entries) flatten(v, path ? `${path}.${k}` : k, out);
  } else {
    out.set(path, JSON.stringify(value));
  }
  return out;
}
