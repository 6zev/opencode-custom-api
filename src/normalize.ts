import type { DiscoveredModel, ModelMetadata } from "./types.js"

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const number = (...values: unknown[]) => values.find((v): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0)
const bool = (...values: unknown[]) => values.find((v): v is boolean => typeof v === "boolean")
export const normalizeCatalogID = (id: string) => id.toLowerCase().replace(/^models\//, "").replace(/[_ ]/g, "-")

function catalogMatch(id: string, catalog?: Record<string, ModelMetadata>): ModelMetadata | undefined {
  if (!catalog) return undefined
  if (catalog[id]) return catalog[id]
  const normalized = normalizeCatalogID(id)
  const matches = Object.entries(catalog).filter(([key]) => normalizeCatalogID(key) === normalized)
  return matches.length === 1 ? matches[0]?.[1] : undefined
}

export function isImageOnly(model: ModelMetadata): boolean {
  const type = typeof model.type === "string" ? model.type.toLowerCase() : ""
  const output = Array.isArray(model.output_modalities) ? model.output_modalities.map(String) : []
  return ((type === "image" || type === "image-generation") && !model.modalities?.includes("text")) || (output.length > 0 && output.includes("image") && !output.includes("text"))
}

export function normalizeModel(raw: ModelMetadata, catalog?: Record<string, ModelMetadata>): DiscoveredModel | undefined {
  const idValue = raw.id ?? raw.name
  if (typeof idValue !== "string" || !idValue || isImageOnly(raw)) return undefined
  const id = idValue
  const match = catalogMatch(id, catalog)
  const endpointCaps = raw.capabilities ?? {}
  const catalogCaps = match?.capabilities ?? {}
  const explicitContext = number(raw.context, raw.context_length, raw.max_context_length)
  const catalogContext = number(match?.context, match?.context_length, match?.max_context_length)
  const explicitOutput = number(raw.output, raw.max_output_tokens)
  const catalogOutput = number(match?.output, match?.max_output_tokens)
  const explicitTools = bool(own(endpointCaps, "tools") ? endpointCaps.tools : undefined, own(raw, "tools") ? raw.tools : undefined, own(raw, "tool_calling") ? raw.tool_calling : undefined)
  const catalogTools = bool(catalogCaps.tools, match?.tools, match?.tool_calling)
  const explicitReasoning = bool(own(endpointCaps, "reasoning") ? endpointCaps.reasoning : undefined, own(raw, "reasoning") ? raw.reasoning : undefined)
  const catalogReasoning = bool(catalogCaps.reasoning, match?.reasoning)
  const explicitInput = Array.isArray(endpointCaps.input) ? endpointCaps.input : Array.isArray(raw.input) ? raw.input : undefined
  const catalogInput = Array.isArray(catalogCaps.input) ? catalogCaps.input : Array.isArray(match?.input) ? match.input : undefined
  const heuristicReasoning = /^(o[1-9](?:-|$)|.*\b(reasoner|reasoning)\b)/i.test(id)
  const source = <T>(explicit: T | undefined, catalogValue: T | undefined, fallback: T, heuristic?: T): [T, "endpoint" | "catalog" | "heuristic" | "default"] =>
    explicit !== undefined ? [explicit, "endpoint"] : catalogValue !== undefined ? [catalogValue, "catalog"] : heuristic !== undefined ? [heuristic, "heuristic"] : [fallback, "default"]
  const [context, contextSource] = source(explicitContext, catalogContext, 32_768)
  const [discoveredOutput, outputSource] = source(explicitOutput, catalogOutput, 4_096)
  const output = Math.min(discoveredOutput, context)
  const [tools, toolsSource] = source(explicitTools, catalogTools, false)
  const [reasoning, reasoningSource] = source(explicitReasoning, catalogReasoning, false, heuristicReasoning ? true : undefined)
  const [input, inputSource] = source(explicitInput, catalogInput, ["text"])
  return { id, name: typeof raw.name === "string" ? raw.name : id, context, output, tools, reasoning, input, ...(typeof raw.type === "string" ? { type: raw.type } : {}), provenance: { context: contextSource, output: outputSource, tools: toolsSource, reasoning: reasoningSource, input: inputSource } }
}
