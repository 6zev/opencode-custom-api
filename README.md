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

With an empty Options field, the plugin automatically inspects OpenCode's merged provider registry. It discovers models for custom providers using `@opencode/ai/providers/openai-compatible`, `@opencode/ai/providers/openai`, `@opencode/ai/providers/anthropic-compatible`, or OpenChamber's legacy `aisdk:@ai-sdk/openai` runtime when `settings.baseURL` is present. OpenCode may normalize the legacy AI SDK package to its native OpenAI runtime; both forms are recognized. Explicit plugin endpoints remain available and override an auto-detected provider with the same ID.

Zero-options example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-custom-api"],
  "providers": {
    "acme": {
      "name": "Acme",
      "env": ["ACME_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://api.example.com/v1",
        "apiKey": "{env:ACME_API_KEY}"
      },
      "models": {}
    }
  }
}
```

That is the whole setup: models appear at startup, are re-checked every 30 minutes, and are re-discovered immediately when the provider or its credential changes. No command has to be run.

### Per-provider tuning (`settings.modelsDiscovery`)

Auto-detected providers can be tuned inside their own provider block. Every key is optional:

```jsonc
"settings": {
  "baseURL": "https://api.example.com/v1",
  "apiKey": "{env:ACME_API_KEY}",
  "modelsDiscovery": {
    "enabled": true,              // false skips this provider
    "endpoint": "/v1/models",     // absolute URL, or a path resolved from the baseURL origin
    "refreshIntervalMs": 600000,  // background re-check; 0 disables it (default 1800000)
    "cacheTtlMs": 300000,
    "timeoutMs": 10000,
    "include": ["^gpt-", "^claude-"],  // case-insensitive regular expressions on the model ID
    "exclude": ["preview$"],           // applied after include
    "pruneMissing": false,        // true: replace the model list instead of merging into it
    "catalog": { "my-model": { "context": 131072, "tools": true } }
  }
}
```

`models.includeRegex` / `models.excludeRegex` are accepted as aliases for `include` / `exclude`. Invalid values in this block are ignored (the plugin-level default applies) so one mistyped provider cannot stop the plugin from loading.

Defaults for every auto-detected provider go in the plugin options:

```jsonc
"plugins": [
  { "package": "opencode-custom-api", "options": { "auto": { "refreshIntervalMs": 600000, "exclude": ["embedding"], "pruneMissing": true } } }
]
```

`auto` accepts `enabled`, `timeoutMs`, `cacheTtlMs`, `refreshIntervalMs`, `include`, `exclude`, and `pruneMissing`. With `"auto": { "enabled": false }`, only providers that set `modelsDiscovery.enabled: true` are discovered.

### Using it with OpenChamber

OpenChamber runs the OpenCode server, so the plugin needs no TUI. Add it once to the global OpenCode config (`~/.config/opencode/opencode.json`, or the directory `OPENCODE_CONFIG_DIR` points to):

```jsonc
{ "$schema": "https://opencode.ai/config.json", "plugins": ["opencode-custom-api"] }
```

Then add the provider in **Settings → Providers → Add provider → Other / Custom** with its base URL and API key. OpenChamber asks for at least one model ID; type any one model and the plugin fills in the rest of the list with metadata. Models added to the gateway later appear after the next background refresh, or immediately by asking the agent to run the `custom_api_refresh` tool. The `custom_api_status` tool shows what was discovered and why.

`settings.apiKey` may use `{env:NAME}` or `{file:path}`. OpenCode resolves these references before exposing provider metadata to the plugin; the plugin does not read arbitrary files itself. If the provider has an active credential saved through `/connect`, that credential takes precedence and is resolved again on refresh. Secrets are used only in memory for discovery requests and are never written to plugin storage.

OpenChamber's provider connection UI stores saved OpenCode credentials in OpenCode's credential store (on Linux, normally `~/.local/share/opencode/opencode.db`). This plugin never opens that database; it uses the public `ctx.integration.connection.active()` and `resolve()` APIs so storage format and access control remain OpenCode's responsibility.

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
| `endpoint` | no | — | Model-list location: absolute URL, or a path beginning with `/` resolved from the `baseURL` origin |
| `include` | no | — | Regular expressions; only matching model IDs are kept |
| `exclude` | no | — | Regular expressions; matching model IDs are dropped (applied after `include`) |

## Discovery and normalization

- If `baseURL` ends in `/v1`, discovery requests `/models` beneath it. Otherwise it tries `/v1/models`, then `/models`. An explicit `endpoint` replaces this guess.
- OpenAI-compatible discovery uses `Authorization: Bearer ...`; Anthropic-compatible discovery uses `x-api-key` plus `anthropic-version`.
- Requests have a timeout and accept cancellation. Cleanup aborts in-flight scheduled refreshes.
- Discovery sends a stable `opencode-custom-api` User-Agent so gateways and Cloudflare-protected endpoints do not reject anonymous HTTP clients before API authentication.
- IDs/names and common context, output, modalities, tools, and reasoning fields are parsed. Besides the flat field names, the plugin reads what common gateways already return, with no extra request and no format setting:

  | Source shape | Fields read |
  |---|---|
  | OpenRouter | `context_length`, `top_provider.max_completion_tokens`, `architecture.input_modalities`, `supported_parameters` |
  | LiteLLM | `model_info.max_input_tokens`, `max_output_tokens`, `supports_function_calling`, `supports_vision`, `supports_reasoning`, `mode` |
  | LM Studio | `max_context_length`, `loaded_context_length`, `capabilities: ["tool_use", "vision"]` |
  | vLLM / llama.cpp | `max_model_len`, `meta.n_ctx_train` |
  | models.dev-style | `limit.context`, `limit.output`, `tool_call`, `modalities.input` |
  | Anthropic | `display_name` |

  `supported_parameters` is treated as complete (a model that does not list `tools` has no tools); a capability *list* only proves what it contains.
- Entries the endpoint itself marks as non-chat are excluded: image-generation-only output, `mode`/`type` of embedding, rerank, moderation, speech or transcription, and new-api `supported_endpoint_types` containing only such types. Nothing is excluded by guessing from the model ID; use `exclude` for that.
- Metadata precedence is: explicit endpoint metadata (including explicit `false`/empty values) → exact or uniquely normalized endpoint catalog key → OpenCode's host-normalized models.dev metadata → narrow conservative heuristic/default.
- Normalized catalog matching only lowercases, removes a leading `models/`, and normalizes spaces/underscores to hyphens. It does not use substring/fuzzy matching.
- Conservative defaults are 32,768 context tokens, 4,096 output tokens, text input, no tools, and no reasoning. Only IDs beginning with `o1`…`o9`, or containing the complete word `reasoner`/`reasoning`, infer reasoning.

OpenCode V2 already bundles, caches, and normalizes models.dev. The plugin reuses those host provider records and never performs a second catalog download or stores a duplicate catalog. Matching is conservative: exact model identity first, then a canonical-provider suffix, then a unique normalized tail; ambiguous matches are rejected and there is no fuzzy token matching. Host variants are copied wholesale (including settings, body, and headers). When there is no host match/variant, documented family fallbacks remain: GPT-5-style models use `low`/`medium`/`high`/`xhigh`, while Kimi K3 uses `low`/`high`/`max`.

## Cache and refresh

Last successful inventories are stored with a version and timestamp using `ctx.storage`; no filesystem path is hard-coded. Credentials and request headers are not cached. A valid fresh entry avoids HTTP. On an expired-cache refresh failure, the last successful inventory is used as stale fallback. An explicitly configured plugin endpoint fails setup when neither discovery nor cache is available; an auto-detected provider keeps its existing configured models so one unavailable endpoint does not prevent the plugin from loading.

Background refresh runs for every source with a positive `refreshIntervalMs`: 30 minutes by default for auto-detected providers, off by default for explicit endpoints. It bypasses the fresh cache, re-registers the provider only when the inventory actually changed, and on failure keeps the previous inventory and logs a warning.

By default discovered models are merged into the provider's configured models, so a model removed from the gateway stays listed. With `pruneMissing: true` the discovered list replaces it. Pruning is skipped whenever the inventory is stale or empty, so an outage never empties a provider.

Manual interfaces:

- Command: `/custom-api-refresh` refreshes all endpoints.
- Tool: `custom_api_refresh` refreshes all endpoints or one optional endpoint ID and cooperates with session cancellation.
- Tool: `custom_api_status` reports, per endpoint, the model count, last refresh time, last error, active filters, and how many models got each field from the endpoint, the catalog, a heuristic, or a default. It makes no network request and returns no credentials.

Refresh resolves the current active provider credential again, updates captured source data, then re-registers the provider overlay at the end of transform order. External HTTP work is always completed before synchronous transform callbacks. For auto-detected providers, discovered metadata overrides configured model metadata on ID collisions.

## Security

- Put secrets in environment variables and use `{ "env": "..." }`. The plugin never writes resolved keys to storage.
- Static header strings are supported for non-secret routing values, but config files may be committed; use env references for anything sensitive.
- Prefer HTTPS for remote endpoints. HTTP is allowed for loopback/private development.
- Discovery errors can contain URLs and HTTP statuses, but never include request headers.

## Limitations

- Compatibility endpoints vary; discovery requires one of the documented response shapes.
- Metadata names are not standardized. Unknown fields are ignored and conservative defaults apply.
- Host catalog enrichment depends on models already exposed through the public provider transform source records; unavailable or ambiguous entries fall back conservatively.
- Saved `/connect` credentials are resolved again on refresh. Environment/file substitutions in provider config are resolved by OpenCode when it reloads configuration.
- The refresh command has no arguments; use the tool when refreshing a single endpoint.
- A plain OpenAI-style list (`id`, `object`, `owned_by` only) carries no metadata. Such models rely on the host catalog match, a `catalog` entry, or the conservative defaults.

## Development

```sh
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

## Publishing

The GitHub Actions workflow at `.github/workflows/publish.yml` publishes the existing [`opencode-custom-api`](https://www.npmjs.com/package/opencode-custom-api) package through npm Trusted Publishing (OIDC). It uses no npm token or repository secret. For release-triggered runs, the release tag (for example `v0.1.0`) must match the version in `package.json`.

Configure the package once on npmjs.com under **Settings → Trusted Publisher → GitHub Actions**:

1. Set the organization or user to `6zev` and repository to `opencode-custom-api`.
2. Set the workflow filename to `publish.yml` (including the extension).
3. Leave the environment blank; this workflow does not use a GitHub environment.
4. Enable **Allow npm publish** rather than provenance-only staging.

To release, update the versions in `package.json` and `package-lock.json`, push the change, and publish a matching GitHub Release. The workflow can also be started manually with **Actions → Publish to npm → Run workflow**.

Every run uses a GitHub-hosted runner, requests `id-token: write`, installs an OIDC-capable npm CLI, tests, type-checks, builds, and publishes. npm generates provenance automatically for Trusted Publisher releases.

## License

MIT
