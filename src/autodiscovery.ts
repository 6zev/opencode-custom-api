import type { Model, Provider } from "@opencode/plugin"
import type { EndpointOptions, Protocol } from "./types.js"

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

export function autoEndpointFromProvider(provider: ProviderCandidate, excluded = new Set<string>()): AutoEndpoint | undefined {
  if (excluded.has(provider.id)) return undefined
  const protocol = PACKAGES[provider.package]
  const baseURL = provider.settings?.baseURL
  if (!protocol || typeof baseURL !== "string" || !/^https?:\/\//.test(baseURL)) return undefined
  const timeout = provider.settings?.timeout
  const endpoint: EndpointOptions = {
    id: provider.id,
    name: provider.name,
    baseURL,
    protocol,
    ...(provider.headers ? { headers: provider.headers } : {}),
    ...(typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
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
  const merged = new Map(discovered.map(model => [model.id, model]))
  for (const model of existing.values()) merged.set(model.id, model)
  return [...merged.values()]
}
