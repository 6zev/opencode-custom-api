# opencode-custom-api

An OpenCode V2 server plugin that discovers chat models from self-hosted or third-party OpenAI-compatible and Anthropic-compatible endpoints and registers them as native OpenCode providers.

## Requirements

- OpenCode with `@opencode/plugin` V2 (this release targets 2.3.x)
- Node.js 20+ when building or testing the npm package
- A model-list endpoint returning an array, `{ "data": [] }`, `{ "models": [] }`, or `{ "models": { "id": {...} } }`

## Install

After the package is published to npm, install it with:

```sh
npm install opencode-custom-api
```

For local development, clone this repository and run `npm install && npm run build`. Then use the plugin directory path in `opencode.jsonc`; paths may be relative to the config file, absolute, or `file://` URLs. A local directory with this package's `name` and `exports` is loaded through those exports:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./path/to/opencode-custom-api",
      "options": { "endpoints": [] }
    }
  ]
}
```

## Configuration

Credentials are **references to environment variables**, never literal API keys:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-custom-api",
      "options": {
        "endpoints": [
          {
            "id": "local-openai",
            "name": "Local OpenAI API",
            "baseURL": "http://127.0.0.1:8000/v1",
            "protocol": "openai-compatible",
            "apiKey": { "env": "LOCAL_OPENAI_API_KEY" },
            "timeoutMs": 10000,
            "cacheTtlMs": 300000,
            "refreshIntervalMs": 0,
            "headers": { "X-Tenant": { "env": "TENANT_ID" } },
            "catalog": {
              "my-model": {
                "context": 131072,
                "max_output_tokens": 8192,
                "capabilities": {
                  "input": ["text", "image"],
                  "tools": true,
                  "reasoning": false
                }
              }
            }
          },
          {
            "id": "private-anthropic",
            "baseURL": "https://gateway.example.com",
            "protocol": "anthropic-compatible",
            "apiKey": { "env": "PRIVATE_ANTHROPIC_KEY" }
          }
        ]
      }
    }
  ]
}
```

### Endpoint options

| Option | Required | Default | Meaning |
|---|---:|---:|---|
| `id` | yes | — | Unique provider ID (`a-z`, digits, `.`, `_`, `-`) |
| `baseURL` | yes | — | HTTP(S) provider base URL |
| `protocol` | yes | — | `openai-compatible` or `anthropic-compatible` |
| `name` | no | `id` | Display name |
| `apiKey` | no | — | `{ "env": "VARIABLE_NAME" }` only |
| `headers` | no | `{}` | Static strings or env references; avoid literal secrets |
| `timeoutMs` | no | `10000` | Per discovery request and runtime provider timeout |
| `cacheTtlMs` | no | `300000` | Fresh-cache lifetime |
| `refreshIntervalMs` | no | `0` | Background refresh interval; zero/absent disables it |
| `catalog` | no | `{}` | Small, endpoint-specific metadata enrichment map keyed by model ID |

## Discovery and normalization

- If `baseURL` ends in `/v1`, discovery requests `/models` beneath it. Otherwise it tries `/v1/models`, then `/models`.
- OpenAI-compatible discovery uses `Authorization: Bearer ...`; Anthropic-compatible discovery uses `x-api-key` plus `anthropic-version`.
- Requests have a timeout and accept cancellation. Cleanup aborts in-flight scheduled refreshes.
- IDs/names and common context, output, modalities, tools, and reasoning fields are parsed.
- Image-generation-only entries are excluded; multimodal models that also produce text remain available.
- Metadata precedence is: explicit endpoint metadata (including explicit `false`) → exact or uniquely normalized endpoint catalog key → narrow conservative heuristic/default.
- Normalized catalog matching only lowercases, removes a leading `models/`, and normalizes spaces/underscores to hyphens. It does not use substring/fuzzy matching.
- Conservative defaults are 32,768 context tokens, 4,096 output tokens, text input, no tools, and no reasoning. Only IDs beginning with `o1`…`o9`, or containing the complete word `reasoner`/`reasoning`, infer reasoning.

OpenCode V2 already integrates models.dev. This plugin deliberately does **not** download or duplicate its full catalog because the plugin API does not expose a stable safe catalog lookup. The optional per-endpoint `catalog` supplies trusted enrichment. Internally each field records endpoint/catalog/heuristic/default provenance. V2 2.3.x has no `capabilities.reasoning` field, so reasoning is adapted through the official `compatibility.requireReasoning` model field; input and tools map directly to V2 capabilities.

## Cache and refresh

Last successful inventories are stored with a version and timestamp using `ctx.storage`; no filesystem path is hard-coded. A valid fresh entry avoids HTTP. On an expired-cache refresh failure, the last successful inventory is used as stale fallback. If no valid cache exists, setup fails rather than registering an invented inventory.

Manual refresh interfaces:

- Command: `/custom-api-refresh` refreshes all endpoints.
- Tool: `custom_api_refresh` refreshes all endpoints or one optional endpoint ID and cooperates with session cancellation.

Refresh updates captured source data, then calls the official provider and model reload APIs. External HTTP work is always completed before synchronous transform callbacks.

## Security

- Put secrets in environment variables and use `{ "env": "..." }`. The plugin never writes resolved keys to storage.
- Static header strings are supported for non-secret routing values, but config files may be committed; use env references for anything sensitive.
- Prefer HTTPS for remote endpoints. HTTP is allowed for loopback/private development.
- Discovery errors can contain URLs and HTTP statuses, but never include request headers.

## Limitations

- Compatibility endpoints vary; discovery requires one of the documented response shapes.
- Metadata names are not standardized. Unknown fields are ignored and conservative defaults apply.
- The plugin cannot safely query OpenCode's private models.dev internals and intentionally avoids private APIs or monkey patching.
- Runtime authentication headers are resolved when the plugin loads. Restart OpenCode after rotating environment variables.
- The refresh command has no arguments; use the tool when refreshing a single endpoint.

## Development

```sh
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

## License

MIT
