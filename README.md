# llm-crashtest

> Record, replay and **break** LLM API calls in your tests.

Test what your app does when the LLM API fails: rate limits, overloaded models, timeouts,
streams cut in the middle. Record real conversations once, replay them offline forever,
and inject failures exactly where you want.

- **17 providers** out of the box: OpenAI, Anthropic, Gemini, Vertex AI, Mistral, Azure OpenAI, Groq,
  DeepSeek, xAI, OpenRouter, Together, Fireworks, Perplexity, Cerebras, Hugging Face, Cohere, Ollama.
- **Any SDK**: works through `fetch`, so the official SDKs, the Vercel AI SDK and LangChain all work.
- **Vitest plugin and Jest helper**: one cassette per test, named automatically.
- **Secrets never reach the cassettes**, and a maintenance CLI keeps them clean.
- Zero runtime dependencies. Node.js ≥ 22.

## Try it in 60 seconds (no API key)

```sh
mkdir try-crashtest && cd try-crashtest && npm init -y
npm i @appystore/llm-crashtest openai
```

```js
// demo.mjs
import OpenAI from "openai";
import { cassetteFetch } from "@appystore/llm-crashtest";

const client = new OpenAI({
  apiKey: "fake-key",
  maxRetries: 0,
  fetch: cassetteFetch({
    dir: "cassettes",
    faults: [{ type: "http", status: 429, retryAfter: 30 }],
  }),
});

try {
  await client.chat.completions.create({
    model: "gpt-5-mini",
    messages: [{ role: "user", content: "Hello" }],
  });
} catch (err) {
  console.log("Simulated failure:", err.constructor.name, err.status); // RateLimitError 429
}
```

```sh
node demo.mjs
```

The real OpenAI SDK throws its real `RateLimitError`. Nothing was sent to OpenAI.

## Install

```sh
npm i -D @appystore/llm-crashtest
```

## Usage with Vitest (recommended)

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
import { llmCassette } from "@appystore/llm-crashtest/vitest";

export default defineConfig({
  plugins: [llmCassette({ dir: "tests/__cassettes__" })],
});
```

That's it. Every test gets its own cassette, named after the test file and title
(`tests/__cassettes__/chat.test/summary/answers in French.json`). Your SDK clients need no
change: the plugin intercepts `globalThis.fetch`, even for clients created at module load.

```ts
import { useCassette } from "@appystore/llm-crashtest";

test("falls back to the backup model when Claude is overloaded", async () => {
  await useCassette("summarize-fallback", {
    faults: [{ on: { model: "claude-main" }, type: "http", status: 529 }],
  });
  const r = await summarize(article);
  expect(r.model).toBe("claude-backup");
});
```

## Usage with Jest

```js
// jest.setup.js  (setupFilesAfterEnv)
const { setupLlmCassettes } = require("@appystore/llm-crashtest/jest");
setupLlmCassettes({ dir: "tests/__cassettes__" });

// jest.global-setup.cjs  (globalSetup, needed for `prune` and `stale`)
module.exports = require("@appystore/llm-crashtest/jest").globalSetup;
```

```js
// jest.config.js
module.exports = {
  setupFilesAfterEnv: ["./jest.setup.js"],
  globalSetup: "./jest.global-setup.cjs",
};
```

## Usage without a test runner plugin

Pass a recording `fetch` to any SDK that accepts one:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { cassetteFetch } from "@appystore/llm-crashtest";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "replay",
  fetch: cassetteFetch({ dir: "tests/__cassettes__", name: "summarize-article" }),
});
```

The first run calls the API and writes `tests/__cassettes__/summarize-article.json`.
Later runs replay it, with no network and no API key.

For SDKs without a `fetch` option (such as `@google/genai`), use global mode:

```ts
import { installGlobalFetch, useCassette } from "@appystore/llm-crashtest";

installGlobalFetch(); // before creating the client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "replay" });
await useCassette("translate", { dir: "tests/__cassettes__" });
```

## Supported providers

| Provider | How to plug it | Intercepted by default |
| --- | --- | --- |
| OpenAI | `new OpenAI({ fetch })` | ✅ |
| Anthropic | `new Anthropic({ fetch })` | ✅ |
| Google Gemini | global mode or Vitest plugin (`@google/genai` has no `fetch` option) | ✅ |
| Vertex AI | global mode or Vitest plugin | ✅ |
| Mistral | `new Mistral({ httpClient: new HTTPClient({ fetcher }) })` | ✅ |
| Azure OpenAI | `new OpenAI({ baseURL, fetch })` | ✅ |
| Groq, DeepSeek, xAI, OpenRouter, Together, Fireworks, Perplexity, Cerebras, Hugging Face | OpenAI SDK with their `baseURL`, `fetch` option | ✅ |
| Cohere | `new CohereClientV2({ fetch })` | ✅ |
| Ollama (local) | `new Ollama({ fetch })` + `providers: ["ollama"]` | opt-in |
| Vercel AI SDK | `createOpenAI({ fetch })`, `createAnthropic({ fetch })`… | ✅ |

Pick providers by name with `providers: ["openai", "groq"]`, or by host with `hosts: ["llm.internal.example"]`.
Requests to other hosts always pass through untouched.

Simulated `http` faults use each provider's real error body, so every SDK throws the same error class as in production.
Streams are recorded chunk by chunk: SSE (OpenAI, Anthropic, Gemini…) and NDJSON (Ollama).

## Break it: fault injection

| Fault        | Options                                   | Effect                                                                                   |
| ------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `http`       | `status`, `retryAfter?`, `shouldRetry?`, `body?` | Error response with the provider's real error body.                              |
| `timeout`    | `afterMs?`                                | Rejects with an `AbortError`; SDKs report a connection timeout.                          |
| `stream-cut` | `afterChunks`                             | Sends N chunks, then the connection drops mid-stream.                                    |
| `malformed`  | `chunk?`                                  | Corrupts one SSE/NDJSON event's JSON (or truncates a JSON body).                         |
| `latency`    | `ms`                                      | Adds a delay before the response.                                                        |

`on` targets the N-th intercepted call (`on: 2`) or a filter (`on: { model: "claude-main" }`); without it, every call fails.
`http` and `timeout` don't consume the recorded interaction, so the SDK's retry gets the recorded answer.
Change faults mid-test with `f.setFaults([...])` (also resets `f.calls`).

## Modes

Set with the `mode` option or the `LLM_CASSETTE` environment variable (the variable wins).

| Mode          | Behaviour                                                         | Default            |
| ------------- | ----------------------------------------------------------------- | ------------------ |
| `auto`        | Replay if recorded, otherwise call the API and record             | Locally            |
| `replay`      | Never touches the network; an unrecorded request throws           | When `CI` is set   |
| `record`      | Always calls the API and rewrites the cassette                    | Never              |
| `passthrough` | Calls the API, writes nothing                                     | Never              |

In `replay` mode, a miss throws `CassetteMissError` with a diff against the closest recorded request.

## Maintenance CLI

The Vitest plugin and the Jest helper record which cassettes and interactions each run used.

```sh
npx llm-crashtest prune                 # cassettes no test read in the last run (add --yes to delete)
npx llm-crashtest stale --check         # cassettes whose requests changed (exit 1 in CI)
npx llm-crashtest rerecord --stale -- npm test   # delete stale cassettes, re-run tests in auto mode
npx llm-crashtest report --base origin/main      # Markdown summary of cassette changes for a PR
```

`prune` only deletes with `--yes`: running a subset of your tests produces a partial trace.

Post the report on pull requests:

```yaml
# .github/workflows/cassettes.yml
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      # Pin actions to a commit SHA in your own workflow.
      - uses: actions/checkout@v4
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      # This job has a write token and runs on PR code: never run install scripts here.
      - run: npm ci --ignore-scripts
      - run: npx llm-crashtest report --base origin/${{ github.base_ref }} --output report.md
      - run: gh pr comment ${{ github.event.pull_request.number }} --body-file report.md --edit-last --create-if-none
        env:
          GH_TOKEN: ${{ github.token }}
```

## Options

| Option                  | Description                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `dir`                   | Cassette directory (required).                                                                     |
| `name`                  | Cassette name, `/` creates sub-folders. Default `default` (automatic with the plugins).            |
| `mode`                  | See above.                                                                                         |
| `providers`             | Providers to intercept, by name. Default: every cloud provider above.                              |
| `hosts`                 | Hostnames to intercept (`api.x.com` or `*.x.com`), instead of `providers`.                         |
| `match`                 | Top-level body fields used for matching. Default: all.                                             |
| `ignore`                | Body paths excluded from matching, e.g. `["metadata.ts", "messages.*.id"]`.                        |
| `faults`                | Faults to inject, see above.                                                                       |
| `replayTiming`          | `instant` (default) or `original` (recorded pacing, for streaming UIs).                            |
| `redact.patterns`       | Extra `RegExp`s masked as `[REDACTED]` before writing.                                             |
| `redact.headers`        | Extra request headers whose values are secrets to mask everywhere.                                 |
| `redact.keepResponseHeaders` | Extra response headers to keep (allowlist).                                                   |
| `maxBodyBytes`          | Max request/response body size. Default 10 MiB.                                                    |
| `recordTransientErrors` | Also record `429` and `5xx` responses. Default `false`.                                            |
| `fetch`                 | Underlying `fetch` for real calls. Default `globalThis.fetch`.                                     |

## Examples

[`examples/`](https://github.com/IT-Skill31/llm-crashtest/tree/main/examples) contains a small app tested
against simulated failures of Anthropic, OpenAI, Groq, Gemini, Ollama and the Vercel AI SDK. It runs with
no API key and no network:

```sh
git clone https://github.com/IT-Skill31/llm-crashtest && cd llm-crashtest
npm ci && npm run build && npm run examples
```

## Security

Cassettes are meant to be committed, so secrets must never reach them:

- **Request headers are never written.** Not `authorization`, not `x-api-key`, nothing.
- **Response headers are allowlisted** (`content-type`, `retry-after`, rate-limit and request-id headers). `set-cookie` and organization ids are dropped.
- **API key values are masked everywhere** they appear (URL, bodies, streams), including keys without a known prefix.
- **Secret-looking strings block the write.** Every string is scanned for OpenAI, Anthropic, Google, Groq, xAI,
  Perplexity, Hugging Face, Fireworks, GitHub and AWS key patterns, OAuth and bearer tokens, and private keys.
  On a match, nothing is written and `SecretDetectedError` tells you where (never the value itself).
- **Credentials in URLs** (`?key=`, `user:pass@`) are removed.
- **Cassette names cannot escape `dir`**, cassette files are validated on read, and the CLI never follows symlinks.
- **`report` escapes cassette content** (HTML, tables, `@mentions`) before it lands in a PR comment.

Still: review cassettes in your PRs like any other code.

## License

MIT
