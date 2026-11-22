import { describe, expect, it } from "vitest"
import { isNonChat, normalizeModel } from "../src/normalize.js"
import { compilePatterns, filterModels } from "../src/filter.js"
import { discoveryURLs } from "../src/discovery.js"
import { DEFAULT_AUTO_REFRESH_MS, autoEndpointFromProvider } from "../src/autodiscovery.js"
import { parsePluginOptions } from "../src/plugin.js"

describe("gateway metadata shapes", () => {
  it("reads OpenRouter-style entries, treating a missing supported parameter as unsupported", () => {
    const model = normalizeModel({
      id: "vendor/model", name: "Vendor Model", context_length: 200_000,
      top_provider: { context_length: 180_000, max_completion_tokens: 64_000 },
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      supported_parameters: ["tools", "reasoning", "temperature"],
    })!
    expect(model).toMatchObject({ name: "Vendor Model", context: 200_000, output: 64_000, tools: true, reasoning: true, input: ["text", "image"] })
    expect(model.provenance).toMatchObject({ context: "endpoint", output: "endpoint", tools: "endpoint", reasoning: "endpoint", input: "endpoint" })
    const plain = normalizeModel({ id: "vendor/plain", supported_parameters: ["temperature"] })!
    expect(plain.tools).toBe(false)
    expect(plain.provenance.tools).toBe("endpoint")
    // An explicit "no reasoning" from the gateway beats the ID heuristic.
    expect(normalizeModel({ id: "o3-mini", supported_parameters: ["tools"] })?.reasoning).toBe(false)
  })

  it("reads LiteLLM model_info and flat supports_* flags", () => {
    const model = normalizeModel({ id: "team/model", model_info: { max_input_tokens: 128_000, max_output_tokens: 16_384, supports_function_calling: true, supports_vision: true, supports_reasoning: false, mode: "chat" } })!
    expect(model).toMatchObject({ context: 128_000, output: 16_384, tools: true, reasoning: false, input: ["text", "image"] })
    expect(normalizeModel({ id: "flat", max_input_tokens: 64_000, supports_function_calling: false, supports_vision: false })).toMatchObject({ context: 64_000, tools: false, input: ["text"] })
  })

  it("reads LM Studio capability lists, vLLM max_model_len, and Anthropic display names", () => {
    expect(normalizeModel({ id: "local", max_context_length: 8_192, capabilities: ["tool_use", "vision"] })).toMatchObject({ context: 8_192, tools: true, input: ["text", "image"] })
    // A capability list proves what is present, not what is absent.
    expect(normalizeModel({ id: "local-2", capabilities: ["vision"] })?.provenance.tools).toBe("default")
    expect(normalizeModel({ id: "vllm", max_model_len: 40_960 })?.context).toBe(40_960)
    expect(normalizeModel({ id: "claude-x", display_name: "Claude X" })).toMatchObject({ name: "Claude X", provenance: { name: "endpoint" } })
  })

  it("drops entries the endpoint itself marks as non-chat, never by guessing from the ID", () => {
    expect(isNonChat({ id: "e", model_info: { mode: "embedding" } })).toBe(true)
    expect(isNonChat({ id: "e", mode: "rerank" })).toBe(true)
    expect(isNonChat({ id: "e", type: "embedding" })).toBe(true)
    expect(isNonChat({ id: "e", supported_endpoint_types: ["embeddings"] })).toBe(true)
    expect(isNonChat({ id: "e", supported_endpoint_types: ["openai", "embeddings"] })).toBe(false)
    expect(isNonChat({ id: "e", architecture: { output_modalities: ["image"] } })).toBe(true)
    expect(isNonChat({ id: "text-embedding-3-large" })).toBe(false)
    expect(normalizeModel({ id: "e", mode: "embedding" })).toBeUndefined()
    // Object-shaped modalities must not throw.
    expect(normalizeModel({ id: "m", modalities: { input: ["text", "image"], output: ["text"] } })?.input).toEqual(["text", "image"])
  })
})

describe("filters and list endpoint", () => {
  const models = [{ id: "gpt-5" }, { id: "GPT-4o" }, { id: "claude-x" }, { id: "gpt-5-preview" }]
  it("applies include then exclude, case-insensitively", () => {
    expect(filterModels(models).map(m => m.id)).toEqual(models.map(m => m.id))
    expect(filterModels(models, ["^gpt"]).map(m => m.id)).toEqual(["gpt-5", "GPT-4o", "gpt-5-preview"])
    expect(filterModels(models, ["^gpt"], ["preview$"]).map(m => m.id)).toEqual(["gpt-5", "GPT-4o"])
    expect(filterModels(models, undefined, ["^claude"]).map(m => m.id)).toEqual(["gpt-5", "GPT-4o", "gpt-5-preview"])
    expect(() => compilePatterns(["("], "x.include")).toThrow(/x\.include: invalid pattern/)
  })

  it("resolves an explicit model-list endpoint from the origin or as an absolute URL", () => {
    expect(discoveryURLs("https://gw.example/v1beta", "/v1/models")).toEqual(["https://gw.example/v1/models"])
    expect(discoveryURLs("https://gw.example/v1", "https://other.example/list")).toEqual(["https://other.example/list"])
    expect(() => discoveryURLs("https://gw.example/v1", "models")).toThrow(/absolute URL or begin with/)
    expect(discoveryURLs("https://gw.example/v1")).toEqual(["https://gw.example/v1/models"])
  })

  it("validates filters, endpoint and auto defaults in plugin options", () => {
    const base = { id: "x", baseURL: "https://x", protocol: "openai-compatible" }
    expect(() => parsePluginOptions({ endpoints: [{ ...base, include: ["("] }] })).toThrow(/x\.include/)
    expect(() => parsePluginOptions({ endpoints: [{ ...base, exclude: "nope" }] })).toThrow(/x\.exclude/)
    expect(() => parsePluginOptions({ endpoints: [{ ...base, endpoint: "models" }] })).toThrow(/x\.endpoint/)
    expect(() => parsePluginOptions({ auto: { refreshIntervalMs: -1 } })).toThrow(/auto\.refreshIntervalMs/)
    expect(() => parsePluginOptions({ auto: { exclude: ["["] } })).toThrow(/auto\.exclude/)
    expect(() => parsePluginOptions({ auto: [] })).toThrow(/auto must be an object/)
    expect(parsePluginOptions({ auto: { enabled: false } })).toEqual({ endpoints: [], auto: { enabled: false } })
  })
})

describe("per-provider discovery settings", () => {
  const provider = (settings: Record<string, unknown> = {}) => ({ id: "acme", name: "Acme", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://api.example.com/v1", ...settings } }) as any

  it("refreshes auto-detected providers in the background by default", () => {
    expect(autoEndpointFromProvider(provider())?.endpoint.refreshIntervalMs).toBe(DEFAULT_AUTO_REFRESH_MS)
    expect(autoEndpointFromProvider(provider(), new Set(), { refreshIntervalMs: 0 })?.endpoint.refreshIntervalMs).toBe(0)
  })

  it("lets settings.modelsDiscovery override plugin-level auto defaults", () => {
    const auto = autoEndpointFromProvider(provider({ timeout: 9_000, modelsDiscovery: {
      endpoint: "/models", timeoutMs: 15_000, cacheTtlMs: 0, refreshIntervalMs: 60_000, pruneMissing: true,
      include: ["^gpt"], models: { excludeRegex: ["preview"] }, catalog: { "gpt-x": { context: 1_000_000 } },
    } }), new Set(), { refreshIntervalMs: 5_000, include: ["ignored"], exclude: ["also-ignored"], pruneMissing: false })
    expect(auto?.endpoint).toMatchObject({ endpoint: "/models", timeoutMs: 15_000, cacheTtlMs: 0, refreshIntervalMs: 60_000, pruneMissing: true, include: ["^gpt"], exclude: ["preview"], catalog: { "gpt-x": { context: 1_000_000 } } })
  })

  it("supports opt-out per provider and opt-in when auto discovery is disabled globally", () => {
    expect(autoEndpointFromProvider(provider({ modelsDiscovery: { enabled: false } }))).toBeUndefined()
    expect(autoEndpointFromProvider(provider(), new Set(), { enabled: false })).toBeUndefined()
    expect(autoEndpointFromProvider(provider({ modelsDiscovery: { enabled: true } }), new Set(), { enabled: false })).toBeDefined()
  })

  it("ignores invalid per-provider values instead of throwing", () => {
    const auto = autoEndpointFromProvider(provider({ modelsDiscovery: { include: ["("], endpoint: "relative", timeoutMs: -5, refreshIntervalMs: "soon" } }), new Set(), { exclude: ["^x"] })
    expect(auto?.endpoint).not.toHaveProperty("include")
    expect(auto?.endpoint).not.toHaveProperty("endpoint")
    expect(auto?.endpoint).not.toHaveProperty("timeoutMs")
    expect(auto?.endpoint).toMatchObject({ exclude: ["^x"], refreshIntervalMs: DEFAULT_AUTO_REFRESH_MS })
  })
})
