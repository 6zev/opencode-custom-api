import type { Model, Provider } from "@opencode/plugin"
import { validPatterns } from "./filter.js"
import type { AutoOptions, EndpointOptions, ModelMetadata, Protocol } from "./types.js"

/** Auto-detected providers re-check their model list this often unless configured otherwise. */
export const DEFAULT_AUTO_REFRESH_MS = 300_000

/**
 * Provider runtimes whose model list this plugin knows how to read. The value only selects
 * how the list request is authenticated; the provider's own runtime is never changed.
 */
const PACKAGES: Record<string, Protocol> = {
  "@opencode/ai/providers/openai-compatible": "openai-compatible",
  "@opencode/ai/providers/openai-compatible/responses": "openai-compatible",
  "@opencode/ai/providers/openai-compatible-responses": "openai-compatible",
  "@opencode/ai/providers/openai": "openai-compatible",
  "@opencode/ai/providers/openai/chat": "openai-compatible",
  "@opencode/ai/providers/openai/responses": "openai-compatible",
  "@opencode/ai/providers/anthropic": "anthropic-compatible",
  "@opencode/ai/providers/anthropic-compatible": "anthropic-compatible",
  "aisdk:@ai-sdk/openai-compatible": "openai-compatible",
  "aisdk:@ai-sdk/openai": "openai-compatible",
  "aisdk:@ai-sdk/anthropic": "anthropic-compatible",
}

/** Providers OpenCode ships itself. Their inventories belong to the host catalog and are left alone. */
const BUILTIN_IDS = new Set([
  "opencode", "opencode-go", "anthropic", "openai", "google", "google-vertex", "github-copilot", "claude-agent",
  "amazon-bedrock", "azure", "openrouter", "mistral", "gitlab",
])

type ProviderShape = { provider: Pick<Provider.Info, "id"> & { canonical?: string | undefined; package?: string | undefined }; models: ReadonlyMap<string, Model.Info> }

/**
 * True when a provider comes from OpenCode's bundled catalog rather than from the user's own configuration.
 * Catalog models carry catalog-only facts (family, release date, pricing); models a user
 * types into a custom provider do not. A custom provider that points `canonical` at another provider inherits
 * such facts on purpose and is still treated as custom.
 */
export function looksBuiltin(record: ProviderShape): boolean {
  const { provider, models } = record
  if (BUILTIN_IDS.has(provider.id)) return true
  if (provider.canonical && provider.canonical !== provider.id) return false
  // The catalog only uses OpenCode's native runtimes; an AI SDK package is always written by the user or by OpenChamber.
  if (provider.package?.startsWith("aisdk:")) return false
  for (const model of models.values()) {
    if (model.family || (model.cost?.length ?? 0) > 0 || (model.time?.released ?? 0) > 0) return true
  }
  return false
}

export interface AutoEndpoint {
  endpoint: EndpointOptions
  integrationID?: string
  settingsApiKey?: string
}

type ProviderCandidate = Pick<Provider.Info, "name" | "package" | "settings" | "headers"> & {
  id: string
  integrationID?: string | undefined
}

const duration = (value: unknown, allowZero: boolean): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0) ? value : undefined
const plainObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/**
 * Builds a discovery endpoint from a provider in OpenCode's registry.
 * Per-provider `settings.modelsDiscovery` overrides the plugin-level `auto` defaults.
 * Invalid per-provider values are ignored rather than thrown, so one bad provider block cannot stop the plugin.
 */
export function autoEndpointFromProvider(provider: ProviderCandidate, excluded = new Set<string>(), defaults: AutoOptions = {}): AutoEndpoint | undefined {
  if (excluded.has(provider.id)) return undefined
  const protocol = PACKAGES[provider.package]
  const baseURL = provider.settings?.baseURL
  if (!protocol || typeof baseURL !== "string" || !/^https?:\/\//.test(baseURL)) return undefined
  const local = plainObject(provider.settings?.modelsDiscovery) ?? {}
  if (local.enabled === false) return undefined
  if (defaults.enabled === false && local.enabled !== true) return undefined
  const filters = plainObject(local.models) ?? {}
  const timeoutMs = duration(local.timeoutMs, false) ?? duration(provider.settings?.timeout, false) ?? duration(defaults.timeoutMs, false)
  const cacheTtlMs = duration(local.cacheTtlMs, true) ?? duration(defaults.cacheTtlMs, true)
  const refreshIntervalMs = duration(local.refreshIntervalMs, true) ?? duration(defaults.refreshIntervalMs, true) ?? DEFAULT_AUTO_REFRESH_MS
  const include = validPatterns(local.include) ?? validPatterns(filters.includeRegex) ?? validPatterns(defaults.include)
  const exclude = validPatterns(local.exclude) ?? validPatterns(filters.excludeRegex) ?? validPatterns(defaults.exclude)
  // Auto-detected providers mirror the upstream list: models it stops listing are removed unless pruning is turned off.
  const pruneMissing = typeof local.pruneMissing === "boolean" ? local.pruneMissing : defaults.pruneMissing !== false
  const listEndpoint = typeof local.endpoint === "string" && (local.endpoint.startsWith("/") || /^https?:\/\//i.test(local.endpoint)) ? local.endpoint : undefined
  const catalog = plainObject(local.catalog) as Record<string, ModelMetadata> | undefined
  const endpoint: EndpointOptions = {
    id: provider.id,
    name: provider.name,
    baseURL,
    protocol,
    refreshIntervalMs,
    ...(provider.headers ? { headers: provider.headers } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(cacheTtlMs !== undefined ? { cacheTtlMs } : {}),
    ...(include?.length ? { include } : {}),
    ...(exclude?.length ? { exclude } : {}),
    pruneMissing,
    ...(listEndpoint ? { endpoint: listEndpoint } : {}),
    ...(catalog ? { catalog } : {}),
  }
  const apiKey = provider.settings?.apiKey
  return {
    endpoint,
    integrationID: provider.integrationID ?? provider.id,
    ...(typeof apiKey === "string" && apiKey ? { settingsApiKey: apiKey } : {}),
  }
}

export function credentialSecret(value: unknown, fallback?: string): string | undefined {
  if (value && typeof value === "object") {
    const credential = value as { type?: unknown; key?: unknown; access?: unknown }
    if (credential.type === "key" && typeof credential.key === "string" && credential.key) return credential.key
    if (credential.type === "oauth" && typeof credential.access === "string" && credential.access) return credential.access
  }
  return fallback || undefined
}

/** How a configured model is reached. Discovery fills in metadata only and never rewrites these. */
const ROUTE_FIELDS = ["package", "settings", "headers", "body", "compatibility", "canonical"] as const

export function keepRoute(discovered: Model.Info, existing?: Model.Info): Model.Info {
  if (!existing) return discovered
  const next: Record<string, unknown> = { ...discovered }
  for (const field of ROUTE_FIELDS) {
    if (existing[field] !== undefined) next[field] = existing[field]
    else delete next[field]
  }
  return next as unknown as Model.Info
}

export function mergeDiscoveredModels(discovered: readonly Model.Info[], existing: ReadonlyMap<string, Model.Info>): Model.Info[] {
  const merged = new Map(existing)
  for (const model of discovered) merged.set(model.id, keepRoute(model, existing.get(model.id)))
  return [...merged.values()]
}
