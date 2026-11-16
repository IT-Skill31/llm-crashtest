export interface Provider {
  name: string;
  hosts: string[];
}

export const PROVIDERS: readonly Provider[] = [
  { name: "openai", hosts: ["api.openai.com"] },
  { name: "anthropic", hosts: ["api.anthropic.com"] },
  { name: "gemini", hosts: ["generativelanguage.googleapis.com"] },
  { name: "mistral", hosts: ["api.mistral.ai"] },
];

/** Domaines interceptés par défaut. Toute autre requête passe sans être touchée. */
export const DEFAULT_HOSTS: readonly string[] = PROVIDERS.flatMap((p) => p.hosts);

/** `api.example.com` (exact) ou `*.example.com` (sous-domaines uniquement). */
export function hostMatches(hostname: string, patterns: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.toLowerCase();
    if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
    return h === p;
  });
}
