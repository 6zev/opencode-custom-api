import { describe, expect, it } from "vitest"
import { Model, Provider } from "@opencode/plugin"
import { autoEndpointFromProvider, credentialSecret, mergeDiscoveredModels } from "../src/autodiscovery.js"

const provider = (overrides: Partial<Provider.Info> = {}): Provider.Info => ({
  ...Provider.Info.empty(Provider.ID.make("acme")),
  name: "Acme",
  package: "@opencode/ai/providers/openai-compatible",
  settings: { baseURL: "https://api.example.com/v1", apiKey: "resolved-key" },
  ...overrides,
})

describe("provider auto-discovery", () => {
  it("extracts supported compatible providers and excludes option overrides", () => {
    const auto = autoEndpointFromProvider(provider())
    expect(auto?.endpoint).toMatchObject({ id: "acme", protocol: "openai-compatible", baseURL: "https://api.example.com/v1" })
    expect(auto?.endpoint).not.toHaveProperty("apiKey")
    expect(JSON.stringify(auto?.endpoint)).not.toContain("resolved-key")
    expect(autoEndpointFromProvider(provider({ package: "@opencode/ai/providers/anthropic-compatible" }))?.endpoint.protocol).toBe("anthropic-compatible")
    expect(autoEndpointFromProvider(provider({ package: "aisdk:@ai-sdk/openai" }))?.endpoint.protocol).toBe("openai-compatible")
    expect(autoEndpointFromProvider(provider({ package: "@opencode/ai/providers/openai" }))).toBeUndefined()
    expect(autoEndpointFromProvider(provider(), new Set(["acme"]))).toBeUndefined()
  })

  it("prefers active credentials and falls back to resolved config values", () => {
    expect(credentialSecret({ type: "key", key: "saved" }, "config")).toBe("saved")
    expect(credentialSecret({ type: "oauth", access: "oauth" }, "config")).toBe("oauth")
    expect(credentialSecret({ type: "external" }, "config")).toBe("config")
    expect(credentialSecret(undefined, "config")).toBe("config")
  })

  it("preserves explicit configured models on ID collisions", () => {
    const id = Provider.ID.make("acme")
    const discovered = { ...Model.Info.default(id, Model.ID.make("same")), name: "Discovered" }
    const explicit = { ...Model.Info.default(id, Model.ID.make("same")), name: "Explicit" }
    const extra = { ...Model.Info.default(id, Model.ID.make("extra")), name: "Extra" }
    const merged = mergeDiscoveredModels([discovered, extra], new Map([["same", explicit]]))
    expect(merged.map(model => [model.id, model.name])).toEqual([["same", "Explicit"], ["extra", "Extra"]])
  })
})
