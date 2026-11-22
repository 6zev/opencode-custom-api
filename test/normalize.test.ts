import { describe, expect, it } from "vitest"
import { normalizeModel } from "../src/normalize.js"

describe("normalization", () => {
  it("uses endpoint > exact/normalized catalog > conservative defaults", () => {
    const catalog = { "models/foo_bar": { context: 99_000, output: 8_000, capabilities: { tools: true, reasoning: true, input: ["text", "image"] } } }
    const model = normalizeModel({ id: "foo-bar", context_length: 12_000, capabilities: { tools: false, reasoning: false } }, catalog)!
    expect(model.context).toBe(12_000)
    expect(model.output).toBe(8_000)
    expect(model.tools).toBe(false)
    expect(model.reasoning).toBe(false)
    expect(model.input).toEqual(["text", "image"])
    expect(model.provenance.tools).toBe("endpoint")
  })

  it("does not fuzzy-match and defaults tools to false", () => {
    const model = normalizeModel({ id: "foo-bar-plus" }, { "foo-bar": { context: 999_999, tools: true } })!
    expect(model.context).toBe(32_768)
    expect(model.tools).toBe(false)
    expect(model.provenance.tools).toBe("default")
  })

  it("uses narrow reasoning heuristic and excludes image-only models", () => {
    expect(normalizeModel({ id: "o3-mini" })?.reasoning).toBe(true)
    expect(normalizeModel({ id: "ai.baselgovernance.org/openai/gpt-5.6-sol" })?.reasoning).toBe(true)
    expect(normalizeModel({ id: "ai.baselgovernance.org/moonshotai/kimi-k3" })?.reasoning).toBe(true)
    expect(normalizeModel({ id: "chat.aqor.io/kimi-k2.5" })?.reasoning).toBe(false)
    expect(normalizeModel({ id: "ai.baselgovernance.org/openai/gpt-5.6-sol", reasoning: false })?.reasoning).toBe(false)
    expect(normalizeModel({ id: "gpt-4o" })?.reasoning).toBe(false)
    expect(normalizeModel({ id: "emotional-support" })?.reasoning).toBe(false)
    expect(normalizeModel({ id: "image", type: "image-generation" })).toBeUndefined()
    expect(normalizeModel({ id: "image-2", output_modalities: ["image"] })).toBeUndefined()
    expect(normalizeModel({ id: "multi", type: "image", modalities: ["text", "image"] })).toBeDefined()
  })

  it("clamps output tokens to the context limit", () => {
    const model = normalizeModel({ id: "odd-model", context: 4_096, output: 8_192 })!
    expect(model.output).toBe(4_096)
    expect(model.output).toBeLessThanOrEqual(model.context)
  })
})
