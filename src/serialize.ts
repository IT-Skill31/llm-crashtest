import { CassetteConfigError } from "./errors.js";
import type { RunnerOptions } from "./runner.js";

/** Options transmises du processus de config aux workers de test (JSON uniquement). */
export interface SerializedRunnerOptions extends Omit<RunnerOptions, "redact"> {
  redact?: {
    patterns?: { source: string; flags: string }[];
    headers?: string[];
    keepResponseHeaders?: string[];
  };
}

export function serializeRunnerOptions(o: RunnerOptions): SerializedRunnerOptions {
  if (!o || typeof o.dir !== "string" || o.dir.trim() === "") {
    throw new CassetteConfigError("L'option `dir` est obligatoire.");
  }
  const { redact, ...rest } = o;
  const out: SerializedRunnerOptions = JSON.parse(JSON.stringify(rest));
  if (redact) {
    out.redact = {
      ...(redact.patterns
        ? { patterns: redact.patterns.map((re) => ({ source: re.source, flags: re.flags })) }
        : {}),
      ...(redact.headers ? { headers: [...redact.headers] } : {}),
      ...(redact.keepResponseHeaders
        ? { keepResponseHeaders: [...redact.keepResponseHeaders] }
        : {}),
    };
  }
  return out;
}

export function deserializeRunnerOptions(o: SerializedRunnerOptions): RunnerOptions {
  const { redact, ...rest } = o;
  if (!redact) return rest;
  return {
    ...rest,
    redact: {
      ...(redact.patterns
        ? { patterns: redact.patterns.map((p) => new RegExp(p.source, p.flags)) }
        : {}),
      ...(redact.headers ? { headers: redact.headers } : {}),
      ...(redact.keepResponseHeaders ? { keepResponseHeaders: redact.keepResponseHeaders } : {}),
    },
  };
}
