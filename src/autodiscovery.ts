import type { Model, Provider } from "@opencode/plugin"
import { validPatterns } from "./filter.js"
import type { AutoOptions, EndpointOptions, ModelMetadata, Protocol } from "./types.js"

/** Auto-detected providers re-check their model list this often unless configured otherwise. */
export const DEFAULT_AUTO_REFRESH_MS = 1_800_000

const PACKAGES: Record<string, Protocol> = {
  "@opencode/ai/providers/openai-compatible": "openai-compatible",
  "@opencode/ai/providers/openai": "openai-compatible",
  "@opencode/ai/providers/anthropic-compatible": "anthropic-compatible",
  "aisdk:@ai-sdk/openai": "openai-compatible",
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
  const pruneMissing = typeof local.pruneMissing === "boolean" ? local.pruneMissing : defaults.pruneMissing === true
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
    ...(pruneMissing ? { pruneMissing } : {}),
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

export function mergeDiscoveredModels(discovered: readonly Model.Info[], existing: ReadonlyMap<string, Model.Info>): Model.Info[] {
  const merged = new Map(existing)
  for (const model of discovered) merged.set(model.id, model)
  return [...merged.values()]
}
