import { describe, expect, it } from "vitest"
import plugin from "../src/index.js"
import { parsePluginOptions } from "../src/plugin.js"

describe("plugin surface", () => {
  it("exports an OpenCode V2 plugin definition without running setup", () => {
    expect(plugin).toMatchObject({ id: "custom-api" })
    expect(typeof plugin.setup).toBe("function")
  })

  it("validates endpoint options without throwing incidental TypeErrors", () => {
    expect(parsePluginOptions(undefined)).toEqual({ endpoints: [] })
    expect(parsePluginOptions({})).toEqual({ endpoints: [] })
    expect(() => parsePluginOptions({ endpoints: "invalid" })).toThrow(/endpoints must be an array/)
    expect(() => parsePluginOptions({ endpoints: [{ id: "bad" }] })).toThrow(/baseURL/)
    expect(() => parsePluginOptions({ endpoints: [{ id: "bad", baseURL: "https://x" }] })).toThrow(/protocol/)
    const base = { id: "x", baseURL: "https://x", protocol: "openai-compatible" }
    for (const invalid of [0, -1, Infinity, Number.NaN]) {
      expect(() => parsePluginOptions({ endpoints: [{ ...base, timeoutMs: invalid }] })).toThrow(/timeoutMs/)
    }
    expect(() => parsePluginOptions({ endpoints: [{ ...base, cacheTtlMs: -1 }] })).toThrow(/cacheTtlMs/)
    expect(() => parsePluginOptions({ endpoints: [{ ...base, refreshIntervalMs: Infinity }] })).toThrow(/refreshIntervalMs/)
    expect(parsePluginOptions({ endpoints: [{ ...base, cacheTtlMs: 0, refreshIntervalMs: 0 }] }).endpoints).toHaveLength(1)
  })
})
