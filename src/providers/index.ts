/** Format du corps d'erreur renvoyé par l'API (pour les pannes `http` réalistes). */
export type ErrorFormat = "openai" | "anthropic" | "gemini" | "mistral" | "cohere" | "ollama";

export interface Provider {
  /** Identifiant utilisé dans l'option `providers`. */
  name: string;
  /** Domaines de l'API. `*.x.com` vise les sous-domaines (ex. ressources Azure, régions Vertex). */
  hosts: readonly string[];
  errorFormat: ErrorFormat;
  /** Interceptés par défaut. Les fournisseurs locaux (Ollama) sont opt-in. */
  default: boolean;
}

export const PROVIDERS: readonly Provider[] = [
  { name: "openai", hosts: ["api.openai.com"], errorFormat: "openai", default: true },
  { name: "anthropic", hosts: ["api.anthropic.com"], errorFormat: "anthropic", default: true },
  {
    name: "gemini",
    hosts: ["generativelanguage.googleapis.com"],
    errorFormat: "gemini",
    default: true,
  },
  {
    name: "vertex",
    hosts: ["aiplatform.googleapis.com", "*-aiplatform.googleapis.com"],
    errorFormat: "gemini",
    default: true,
  },
  { name: "mistral", hosts: ["api.mistral.ai"], errorFormat: "mistral", default: true },
  {
    name: "azure-openai",
    hosts: ["*.openai.azure.com", "*.services.ai.azure.com"],
    errorFormat: "openai",
    default: true,
  },
  { name: "groq", hosts: ["api.groq.com"], errorFormat: "openai", default: true },
  { name: "deepseek", hosts: ["api.deepseek.com"], errorFormat: "openai", default: true },
  { name: "xai", hosts: ["api.x.ai"], errorFormat: "openai", default: true },
  { name: "openrouter", hosts: ["openrouter.ai"], errorFormat: "openai", default: true },
  {
    name: "together",
    hosts: ["api.together.xyz", "api.together.ai"],
    errorFormat: "openai",
    default: true,
  },
  { name: "fireworks", hosts: ["api.fireworks.ai"], errorFormat: "openai", default: true },
  { name: "perplexity", hosts: ["api.perplexity.ai"], errorFormat: "openai", default: true },
  { name: "cerebras", hosts: ["api.cerebras.ai"], errorFormat: "openai", default: true },
  {
    name: "huggingface",
    hosts: ["router.huggingface.co", "api-inference.huggingface.co"],
    errorFormat: "openai",
    default: true,
  },
  {
    name: "cohere",
    hosts: ["api.cohere.com", "api.cohere.ai"],
    errorFormat: "cohere",
    default: true,
  },
  {
    name: "ollama",
    hosts: ["localhost", "127.0.0.1", "[::1]"],
    errorFormat: "ollama",
    default: false,
  },
];

export type ProviderName = (typeof PROVIDERS)[number]["name"];

/** Domaines interceptés par défaut. Toute autre requête passe sans être touchée. */
export const DEFAULT_HOSTS: readonly string[] = PROVIDERS.filter((p) => p.default).flatMap(
  (p) => p.hosts,
);

/** Domaines des fournisseurs nommés, ex. `hostsFor(["openai", "ollama"])`. */
export function hostsFor(names: readonly string[]): string[] {
  return names.flatMap((name) => {
    const p = PROVIDERS.find((x) => x.name === name);
    if (!p) {
      throw new TypeError(
        `Fournisseur inconnu : "${name}". Connus : ${PROVIDERS.map((x) => x.name).join(", ")}.`,
      );
    }
    return [...p.hosts];
  });
}

/** `api.example.com` (exact) ou `*.example.com` / `*-suffix.example.com` (préfixe joker). */
export function hostMatches(hostname: string, patterns: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.toLowerCase();
    if (p.startsWith("*")) {
      const suffix = p.slice(1);
      return h.endsWith(suffix) && h.length > suffix.length;
    }
    return h === p;
  });
}

export function providerForUrl(url: URL): Provider | undefined {
  return PROVIDERS.find((p) => hostMatches(url.hostname, p.hosts));
}

/** Format d'erreur : par domaine connu, sinon déduit du chemin (serveurs locaux, proxys). */
export function errorFormatFor(url: URL): ErrorFormat {
  const p = url.pathname;
  if (p.endsWith("/v1/messages")) return "anthropic";
  if (/:(stream)?generateContent$/i.test(p)) return "gemini";
  if (/^\/api\/(chat|generate|embed)/.test(p)) return "ollama";
  const known = providerForUrl(url);
  if (known && known.name !== "ollama") return known.errorFormat;
  return "openai";
}
