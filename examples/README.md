# Examples

A small app ([`app.ts`](app.ts)) that calls six different LLM SDKs, and tests
([`resilience.example.ts`](resilience.example.ts)) that check how it behaves when each API fails.

They run **without any API key and without network**: every failure is simulated by llm-crashtest.

```sh
npm ci
npm run build
npm run examples
```

| Test | SDK | Simulated failure | Expected behaviour |
| --- | --- | --- | --- |
| Anthropic overloaded | `@anthropic-ai/sdk` | HTTP 529 | Local extractive summary |
| OpenAI rate limited | `openai` | HTTP 429 + `retry-after: 20` | "Try again in 20 seconds" |
| Groq timeout | `openai` with Groq `baseURL` | Timeout | Default category |
| Gemini unavailable | `@google/genai` (no `fetch` option) | HTTP 503 | Original text kept |
| Ollama down | `ollama` | HTTP 500 | Help message |
| Vercel AI SDK | `ai` + `@ai-sdk/openai` | HTTP 429 on every call | Error after the SDK's retry |

The config ([`vitest.config.ts`](vitest.config.ts)) uses the Vitest plugin, so the app's clients need no change.
It forces `LLM_CASSETTE=replay`: any call that is not simulated fails instead of reaching a real API.
