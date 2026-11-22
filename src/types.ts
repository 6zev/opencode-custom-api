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
  capabilities?: CapabilityMetadata
  input?: string[]
  tools?: boolean
  tool_calling?: boolean
  reasoning?: boolean
  type?: string
  modalities?: string[]
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
}
export interface PluginOptions { endpoints: EndpointOptions[] }
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
