# llm-crashtest

> Record, replay and **break** LLM API calls in your tests.

> **Status: 0.x, early preview.** Record/replay of non-streaming calls works today.
> Streaming replay and fault injection (`429`, `529`, timeouts, cut streams) are coming in 0.3.

Works with any SDK that accepts a `fetch` option (OpenAI, Anthropic, Mistral, Gemini, Vercel AI SDK…).
Zero runtime dependencies. Node.js ≥ 22.

## Install

```sh
npm i -D @stackapi/llm-crashtest
```

## Usage

```ts
import Anthropic from "@anthropic-ai/sdk";
import { cassetteFetch } from "@stackapi/llm-crashtest";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? "replay",
  fetch: cassetteFetch({ dir: "tests/__cassettes__", name: "summarize-article" }),
});
```

The first run calls the API and writes `tests/__cassettes__/summarize-article.json`.
Later runs replay it, with no network and no API key.

## Modes

Set with the `mode` option or the `LLM_CASSETTE` environment variable (the variable wins).

| Mode          | Behaviour                                                         | Default            |
| ------------- | ----------------------------------------------------------------- | ------------------ |
| `auto`        | Replay if recorded, otherwise call the API and record             | Locally            |
| `replay`      | Never touches the network; an unrecorded request throws           | When `CI` is set   |
| `record`      | Always calls the API and rewrites the cassette                    | Never              |
| `passthrough` | Calls the API, writes nothing                                     | Never              |

In `replay` mode, a miss throws `CassetteMissError` with a diff against the closest recorded request.
Tip: set `maxRetries: 0` on your SDK client in tests so a miss fails immediately.

## Options

| Option                  | Description                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `dir`                   | Cassette directory (required).                                                                     |
| `name`                  | Cassette name, `/` creates sub-folders. Default `default`.                                         |
| `mode`                  | See above.                                                                                         |
| `match`                 | Top-level body fields used for matching. Default: all.                                             |
| `ignore`                | Body paths excluded from matching, e.g. `["metadata.ts", "messages.*.id"]`.                        |
| `hosts`                 | Intercepted hostnames (`api.x.com` or `*.x.com`). Defaults to the OpenAI, Anthropic, Gemini and Mistral APIs. Other requests pass through untouched. |
| `redact.patterns`       | Extra `RegExp`s masked as `[REDACTED]` before writing.                                             |
| `redact.headers`        | Extra request headers whose values are secrets to mask everywhere.                                 |
| `redact.keepResponseHeaders` | Extra response headers to keep (allowlist).                                                   |
| `maxBodyBytes`          | Max request/response body size. Default 10 MiB.                                                    |
| `recordTransientErrors` | Also record `429` and `5xx` responses. Default `false`.                                            |
| `fetch`                 | Underlying `fetch` for real calls. Default `globalThis.fetch`.                                     |

## Security

Cassettes are meant to be committed, so secrets must never reach them:

- **Request headers are never written.** Not `authorization`, not `x-api-key`, nothing.
- **Response headers are allowlisted** (`content-type`, `retry-after`, rate-limit and request-id headers). `set-cookie` and organization ids are dropped.
- **API key values are masked everywhere** they appear (URL, bodies), including keys without a known prefix.
- **Secret-looking strings block the write.** Before writing, every string is scanned for OpenAI, Anthropic, Google, GitHub and AWS key patterns, bearer tokens and private keys. On a match, nothing is written and `SecretDetectedError` tells you where (never the value itself).
- **Credentials in URLs** (`?key=`, `user:pass@`) are removed.
- **Cassette names cannot escape `dir`** (path traversal is rejected), and cassette files are validated on read.

Still: review cassettes in your PRs like any other code.

## License

MIT
