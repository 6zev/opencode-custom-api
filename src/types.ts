export type Protocol = "openai-compatible" | "anthropic-compatible"

export interface EnvReference { env: string }
export interface CapabilityMetadata {
  input?: string[]
  tools?: boolean
  reasoning?: boolean
}
export interface ModelMetadata {
  id?: string
  name?: string
  context?: number
  context_length?: number
  max_context_length?: number
  output?: number
  max_output_tokens?: number
  /** Flat capability object, or a capability name list as LM Studio reports it. */
  capabilities?: CapabilityMetadata | string[]
  input?: string[]
  tools?: boolean
  tool_calling?: boolean
  reasoning?: boolean
  type?: string
  modalities?: string[] | { input?: string[]; output?: string[] }
  output_modalities?: string[]
  [key: string]: unknown
}
export interface EndpointOptions {
  id: string
  name?: string
  baseURL: string
  protocol: Protocol
  apiKey?: EnvReference
  headers?: Record<string, string | EnvReference>
  timeoutMs?: number
  cacheTtlMs?: number
  refreshIntervalMs?: number
  catalog?: Record<string, ModelMetadata>
  /** Model-list location: an absolute URL, or a path beginning with `/` resolved from the baseURL origin. */
  endpoint?: string
  /** Regular expressions; when present only matching model IDs are kept. */
  include?: string[]
  /** Regular expressions; matching model IDs are dropped. Applied after `include`. */
  exclude?: string[]
  /** Auto-detected providers only: replace the provider's model list instead of merging into it. */
  pruneMissing?: boolean
}
/** Defaults applied to providers found in OpenCode's registry rather than declared in `endpoints`. */
export interface AutoOptions {
  enabled?: boolean
  timeoutMs?: number
  cacheTtlMs?: number
  refreshIntervalMs?: number
  include?: string[]
  exclude?: string[]
  pruneMissing?: boolean
  /** Also discover providers that OpenCode ships itself (OpenCode Zen, Go, OpenAI, ...). Off by default. */
  builtin?: boolean
  /** When present, only these provider IDs are auto-discovered. */
  providers?: string[]
}
export interface PluginOptions {
  endpoints: EndpointOptions[]
  auto?: AutoOptions
  /** `false` turns off the models.dev metadata fallback; a URL points it at a mirror. On by default. */
  modelsDev?: boolean | string
}
export interface DiscoveredModel {
  id: string
  name: string
  context: number
  output: number
  input: string[]
  tools: boolean
  reasoning: boolean
  type?: string
  provenance: Record<string, "endpoint" | "catalog" | "heuristic" | "default">
}
export interface CacheEntry { version: 1; savedAt: number; models: DiscoveredModel[] }
