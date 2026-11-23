import { afterEach, describe, expect, it, vi } from "vitest"
import plugin from "../src/index.js"
import { buildIndex, loadKnownModels, lookupKnown } from "../src/modelsdev.js"
import { parsePluginOptions } from "../src/plugin.js"

const api = {
  opencode: { models: { "deepseek-v4.1-flash-free": { limit: { context: 200_000, output: 32_000 }, reasoning: true, tool_call: true, modalities: { input: ["text"] } } } },
  a: { models: { "deepseek-ai/DeepSeek-V4.1-Flash": { limit: { context: 1_048_576, output: 384_000 }, reasoning: true, tool_call: true, modalities: { input: ["text", "image"] } } } },
  b: { models: { "deepseek-v4.1-flash": { limit: { context: 1_048_576, output: 384_000 }, reasoning: true, tool_call: true } } },
  c: { models: { "deepseek-v4.1-flash": { limit: { context: 1_000_000, output: 131_072 }, reasoning: false, tool_call: true }, broken: { limit: {} }, "embed-1": { limit: { context: 8192, output: 0 } } } },
  junk: "not a provider",
}

afterEach(() => { vi.unstubAllGlobals() })

describe("models.dev fallback", () => {
  it("collapses the catalog into one consensus record per model name", () => {
    const index = buildIndex(api)
    expect(index["deepseek-v4.1-flash"]).toEqual({ context: 1_048_576, output: 384_000, tools: true, reasoning: true, input: ["text", "image"] })
    expect(index["embed-1"]).toMatchObject({ context: 8192, output: 4096, tools: false, reasoning: false })
    expect(index.broken).toBeUndefined()
    expect(buildIndex("nope")).toEqual({})
  })

  it("finds a model by its last ID segment, then without a routing tag or -free marker", () => {
    const index = buildIndex(api)
    expect(lookupKnown(index, "opencode2api/deepseek-v4.1-flash-free")?.context).toBe(200_000)
    expect(lookupKnown(index, "tokenharbor/deepseek-v4.1-flash:free")?.context).toBe(1_048_576)
    expect(lookupKnown(index, "SiliconFlow/deepseek-ai/DeepSeek-V4.1-Flash")?.reasoning).toBe(true)
    expect(lookupKnown(index, "gw/kimi-k9-free")).toBeUndefined()
    expect(lookupKnown(index, "constructor")).toBeUndefined()
  })

  it("downloads once a day and survives an outage on the stored copy", async () => {
    const store = new Map<string, unknown>()
    const storage = { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value) } }
    const ok = vi.fn(async () => new Response(JSON.stringify(api)))
    expect(Object.keys((await loadKnownModels(storage, undefined, undefined, ok as never, 1_000)).index)).toContain("deepseek-v4.1-flash")
    await loadKnownModels(storage, undefined, undefined, ok as never, 2_000)
    expect(ok).toHaveBeenCalledTimes(1)
    const down = vi.fn(async () => new Response("no", { status: 503 }))
    const stale = await loadKnownModels(storage, undefined, undefined, down as never, 1_000 + 90_000_000)
    expect(stale.error).toContain("503")
    expect(stale.index["deepseek-v4.1-flash"]?.context).toBe(1_048_576)
    expect((await loadKnownModels({ get: async () => undefined, set: async () => {} }, undefined, undefined, down as never)).index).toEqual({})
  })

  it("validates the modelsDev option", () => {
    expect(parsePluginOptions({ modelsDev: false })).toEqual({ endpoints: [], modelsDev: false })
    expect(parsePluginOptions({ modelsDev: "https://mirror.example/api.json" }).modelsDev).toBe("https://mirror.example/api.json")
    expect(() => parsePluginOptions({ modelsDev: "nope" })).toThrow(/modelsDev/)
  })

  it("fills context, output and reasoning for gateway models that list only an ID", async () => {
    const gateway = { data: [
      { id: "opencode2api/deepseek-v4.1-flash-free", object: "model" },
      { id: "has/own", context_length: 64_000, max_output_tokens: 8_000, reasoning: false, tool_call: false },
      { id: "nobody/knows-this" },
      { id: "chan/deepseek-v4.1-flash" },
      { id: "chan/deepseek-v4.1-flash:batch" },
    ] }
    const hosts: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => { const host = new URL(String(url)).host; hosts.push(host); return new Response(JSON.stringify(host === "models.dev" ? { ...api, x: { models: { own: { limit: { context: 999_999, output: 9 }, reasoning: true, tool_call: true } } } } : gateway)) }))
    const transforms: ((editor: any) => void)[] = []
    const fold = () => {
      const records = new Map<string, any>()
      const editor = { get: (id: string) => records.get(id), list: () => [...records.values()], add: ({ info, models }: any) => records.set(info.id, { provider: info, models: new Map(models.map((m: any) => [m.id, m])) }), models: { set: (id: string, models: any[]) => { const r = records.get(id); if (r) r.models = new Map(models.map(m => [m.id, m])) } } }
      for (const transform of transforms) transform(editor)
      return records
    }
    // The host catalog only knows the base model (1M); the catalog entry for the "-free" name must win over it.
    transforms.push(editor => editor.add({ info: { id: "deepseek", name: "DeepSeek", activation: "enabled", package: "@opencode/ai/providers/deepseek", settings: {} }, models: [{ id: "deepseek-v4.1-flash", modelID: "deepseek-v4.1-flash", providerID: "deepseek", name: "Flash", family: "deepseek", variants: [{ id: "high", settings: {} }], cost: [], time: { released: 1 }, capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 1_048_576, output: 384_000 } }] }))
    transforms.push(editor => editor.add({ info: { id: "gw", name: "GW", activation: "enabled", package: "aisdk:@ai-sdk/openai-compatible", settings: { baseURL: "https://gw.example/v1", modelsDiscovery: { refreshIntervalMs: 0 } } }, models: [] }))
    const provider = { transform: vi.fn(async (cb: any) => { transforms.push(cb); fold(); return { dispose: async () => { const i = transforms.indexOf(cb); if (i >= 0) transforms.splice(i, 1) } } }), list: vi.fn(async () => ({ location: {}, data: [...fold().values()].map(r => r.provider) })) }
    const tools: any[] = []
    const registration = vi.fn(async (cb: any) => { cb({ namespace: vi.fn(), add: (tool: any) => tools.push(tool) }); return { dispose: vi.fn(async () => {}) } })
    const event = { subscribe: ({ signal }: any) => ({ async *[Symbol.asyncIterator]() { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })) } }) }
    const ctx = { options: {}, provider, tool: { transform: registration }, command: { transform: registration }, event, storage: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) }, integration: { connection: { active: vi.fn(async () => undefined), resolve: vi.fn(async () => undefined) } } }
    const cleanup = await plugin.setup(ctx as never)
    const models = fold().get("gw").models
    const flash = models.get("opencode2api/deepseek-v4.1-flash-free")
    expect(flash.limit).toMatchObject({ context: 200_000, output: 32_000 })
    expect(flash.capabilities.tools).toBe(true)
    expect(models.get("chan/deepseek-v4.1-flash").limit.context).toBe(1_048_576)
    expect(models.get("chan/deepseek-v4.1-flash:batch").limit.context).toBe(1_048_576)
    expect(flash.variants.length).toBeGreaterThan(0)
    // What the gateway states is never overridden by the catalog.
    expect(models.get("has/own").limit).toMatchObject({ context: 64_000, output: 8_000 })
    expect(models.get("has/own").variants).toEqual([])
    expect(models.get("nobody/knows-this").limit.context).toBe(32_768)
    expect(hosts).toContain("models.dev")
    const report = JSON.parse((await tools.find(tool => tool.name === "status").execute({}, {})).content)
    expect(report.find((item: any) => item.endpoint === "gw")).toMatchObject({ knownByModelsDev: 3 })
    expect(report.at(-1)).toMatchObject({ endpoint: "models.dev", mode: "metadata" })
    await cleanup?.()
  })
})
