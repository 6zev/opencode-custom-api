import type { DiscoveredModel, ModelMetadata } from "./types.js"

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const number = (...values: unknown[]) => values.find((v): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0)
const bool = (...values: unknown[]) => values.find((v): v is boolean => typeof v === "boolean")
const record = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.every(item => typeof item === "string") ? value.map(item => item.toLowerCase()) : undefined
export const normalizeCatalogID = (id: string) => id.toLowerCase().replace(/^models\//, "").replace(/[_ ]/g, "-")

function catalogMatch(id: string, catalog?: Record<string, ModelMetadata>): ModelMetadata | undefined {
  if (!catalog) return undefined
  if (catalog[id]) return catalog[id]
  const normalized = normalizeCatalogID(id)
  const matches = Object.entries(catalog).filter(([key]) => normalizeCatalogID(key) === normalized)
  return matches.length === 1 ? matches[0]?.[1] : undefined
}

/**
 * Model-list endpoints are not standardized. These readers cover the shapes
 * returned by common gateways (OpenRouter, LiteLLM, LM Studio, vLLM, llama.cpp,
 * new-api/one-api) in addition to this plugin's own flat field names.
 */
function gatewayContext(raw: ModelMetadata): number | undefined {
  const info = record(raw.model_info)
  return number(
    raw.context, raw.context_length, raw.max_context_length, raw.context_window, raw.max_input_tokens, raw.max_model_len,
    record(raw.top_provider).context_length, record(raw.limit).context, record(raw.limits).context,
    info.max_input_tokens, info.context_length, raw.loaded_context_length, record(raw.meta).n_ctx_train,
  )
}

function gatewayOutput(raw: ModelMetadata): number | undefined {
  const info = record(raw.model_info)
  return number(
    raw.output, raw.max_output_tokens, raw.max_completion_tokens,
    record(raw.top_provider).max_completion_tokens, record(raw.limit).output, record(raw.limits).output,
    info.max_output_tokens,
  )
}

function gatewayTools(raw: ModelMetadata): boolean | undefined {
  const caps = raw.capabilities
  const info = record(raw.model_info)
  const flat = bool(
    !Array.isArray(caps) && caps && own(caps, "tools") ? (caps as Record<string, unknown>).tools : undefined,
    own(raw, "tools") ? raw.tools : undefined, own(raw, "tool_calling") ? raw.tool_calling : undefined,
    raw.tool_call, raw.supports_tools, raw.supports_function_calling, info.supports_function_calling, info.supports_tool_choice,
  )
  if (flat !== undefined) return flat
  // OpenRouter lists every accepted request parameter, so absence is meaningful.
  const supported = strings(raw.supported_parameters)
  if (supported) return supported.includes("tools")
  // LM Studio reports a capability list; an entry proves support, absence proves nothing.
  const listed = strings(caps)
  if (listed?.some(item => item === "tool_use" || item === "tools" || item === "function_calling")) return true
  return undefined
}

function gatewayReasoning(raw: ModelMetadata): boolean | undefined {
  const caps = raw.capabilities
  const info = record(raw.model_info)
  const flat = bool(
    !Array.isArray(caps) && caps && own(caps, "reasoning") ? (caps as Record<string, unknown>).reasoning : undefined,
    own(raw, "reasoning") ? raw.reasoning : undefined, raw.supports_reasoning, info.supports_reasoning,
  )
  if (flat !== undefined) return flat
  const supported = strings(raw.supported_parameters)
  if (supported) return supported.some(item => item === "reasoning" || item === "reasoning_effort" || item === "include_reasoning")
  if (strings(caps)?.includes("reasoning")) return true
  return undefined
}

function gatewayInput(raw: ModelMetadata): string[] | undefined {
  const caps = raw.capabilities
  const flat = !Array.isArray(caps) && caps ? strings((caps as Record<string, unknown>).input) : undefined
  const listed = flat ?? strings(raw.input) ?? strings(raw.input_modalities) ?? strings(record(raw.architecture).input_modalities) ?? strings(record(raw.modalities).input)
  if (listed?.length) return listed
  const info = record(raw.model_info)
  const vision = bool(raw.supports_vision, info.supports_vision, raw.vision)
  if (vision !== undefined) return vision ? ["text", "image"] : ["text"]
  if (strings(caps)?.some(item => item === "vision" || item === "image")) return ["text", "image"]
  return undefined
}

const NON_CHAT = new Set(["embedding", "embeddings", "rerank", "reranker", "jina-rerank", "moderation", "moderations", "tts", "stt", "audio", "audio_speech", "audio_transcription", "speech", "transcription", "image", "image-generation", "image_generation", "video", "video-generation", "video_generation"])

/** True when the endpoint itself says the entry cannot be used for chat. Never inferred from the model ID. */
export function isNonChat(model: ModelMetadata): boolean {
  if (isImageOnly(model)) return true
  const mode = [model.mode, record(model.model_info).mode].find((value): value is string => typeof value === "string")
  if (mode && NON_CHAT.has(mode.toLowerCase())) return true
  const type = typeof model.type === "string" ? model.type.toLowerCase() : ""
  if (type && type !== "image" && type !== "image-generation" && NON_CHAT.has(type)) return true
  // new-api / one-api: every advertised endpoint type is a non-chat one.
  const endpoints = strings(model.supported_endpoint_types)
  if (endpoints?.length && endpoints.every(item => NON_CHAT.has(item))) return true
  return false
}

export function isImageOnly(model: ModelMetadata): boolean {
  const type = typeof model.type === "string" ? model.type.toLowerCase() : ""
  const output = strings(model.output_modalities) ?? strings(record(model.architecture).output_modalities) ?? strings(record(model.modalities).output) ?? []
  const modalities = strings(model.modalities)
  return ((type === "image" || type === "image-generation") && !modalities?.includes("text")) || (output.length > 0 && output.includes("image") && !output.includes("text"))
}

export function normalizeModel(raw: ModelMetadata, catalog?: Record<string, ModelMetadata>): DiscoveredModel | undefined {
  const idValue = raw.id ?? raw.name
  if (typeof idValue !== "string" || !idValue || isNonChat(raw)) return undefined
  const id = idValue
  const match = catalogMatch(id, catalog)
  const explicitContext = gatewayContext(raw)
  const catalogContext = match ? gatewayContext(match) : undefined
  const explicitOutput = gatewayOutput(raw)
  const catalogOutput = match ? gatewayOutput(match) : undefined
  const explicitTools = gatewayTools(raw)
  const catalogTools = match ? gatewayTools(match) : undefined
  const explicitReasoning = gatewayReasoning(raw)
  const catalogReasoning = match ? gatewayReasoning(match) : undefined
  const explicitInput = gatewayInput(raw)
  const catalogInput = match ? gatewayInput(match) : undefined
  const heuristicReasoning = /^(o[1-9](?:-|$)|.*\b(reasoner|reasoning)\b)/i.test(id) || /(?:^|\/)gpt-5(?:[.-]|$)/i.test(id) || /(?:^|\/)kimi-k3(?:[.-]|$)/i.test(id)
  const source = <T>(explicit: T | undefined, catalogValue: T | undefined, fallback: T, heuristic?: T): [T, "endpoint" | "catalog" | "heuristic" | "default"] =>
    explicit !== undefined ? [explicit, "endpoint"] : catalogValue !== undefined ? [catalogValue, "catalog"] : heuristic !== undefined ? [heuristic, "heuristic"] : [fallback, "default"]
  const [context, contextSource] = source(explicitContext, catalogContext, 32_768)
  const [discoveredOutput, outputSource] = source(explicitOutput, catalogOutput, 4_096)
  const output = Math.min(discoveredOutput, context)
  const [tools, toolsSource] = source(explicitTools, catalogTools, false)
  const [reasoning, reasoningSource] = source(explicitReasoning, catalogReasoning, false, heuristicReasoning ? true : undefined)
  const [input, inputSource] = source(explicitInput, catalogInput, ["text"])
  // `id` is the routing key; a separate display name may come from `name` or Anthropic's `display_name`.
  const rawName = typeof raw.name === "string" && raw.name ? raw.name : typeof raw.display_name === "string" && raw.display_name ? raw.display_name : undefined
  const matchName = typeof match?.name === "string" ? match.name : undefined
  return { id, name: rawName ?? matchName ?? id, context, output, tools, reasoning, input, ...(typeof raw.type === "string" ? { type: raw.type } : typeof match?.type === "string" ? { type: match.type } : {}), provenance: { context: contextSource, output: outputSource, tools: toolsSource, reasoning: reasoningSource, input: inputSource, name: rawName ? "endpoint" : matchName ? "catalog" : "default", type: typeof raw.type === "string" ? "endpoint" : typeof match?.type === "string" ? "catalog" : "default" } }
}
