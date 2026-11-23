import { afterEach, describe, expect, it, vi } from "vitest"
import plugin, { looksBuiltin } from "../src/index.js"

afterEach(() => { vi.restoreAllMocks() })

const model = (providerID: string, id: string, extra: Record<string, unknown> = {}) => ({ id, modelID: id, providerID, name: id, variants: [], cost: [], time: { released: 0 }, capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 1000, output: 100 }, ...extra })

/** Host with OpenCode Zen (catalog models) next to two user-configured providers. */
function host(options: unknown = {}, zenSettings: Record<string, unknown> = {}) {
  const transforms: ((editor: any) => void)[] = []
  const fold = () => {
    const records = new Map<string, any>()
    const editor = {
      get: (id: string) => records.get(id), list: () => [...records.values()],
      add: ({ info, models }: any) => records.set(info.id, { provider: info, models: new Map(models.map((item: any) => [item.id, item])) }),
      models: { set: (id: string, models: any[]) => { const record = records.get(id); if (record) record.models = new Map(models.map(item => [item.id, item])) } },
    }
    for (const transform of transforms) transform(editor)
    return records
  }
  transforms.push(editor => {
    editor.add({
      info: { id: "opencode", name: "OpenCode Zen", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://zen.example/v1", ...zenSettings } },
      models: [model("opencode", "zen-big", { family: "zen", cost: [{ input: 1 }], time: { released: 1_700_000_000 }, package: "@opencode/ai/providers/anthropic" })],
    })
    editor.add({
      info: { id: "lookalike", name: "Unlisted built-in", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://lookalike.example/v1" } },
      models: [model("lookalike", "cat-1", { family: "cat" })],
    })
    editor.add({
      info: { id: "gw", name: "Gateway", activation: "enabled", package: "aisdk:@ai-sdk/openai-compatible", settings: { baseURL: "https://gw.example/v1" } },
      models: [model("gw", "mine", { package: "aisdk:@ai-sdk/anthropic", settings: { baseURL: "https://gw.example/anthropic" } })],
    })
  })
  const tools = new Map<string, any>()
  const provider = {
    transform: vi.fn(async (callback: (editor: any) => void) => { transforms.push(callback); fold(); return { dispose: async () => { const i = transforms.indexOf(callback); if (i >= 0) transforms.splice(i, 1); fold() } } }),
    list: vi.fn(async () => ({ location: {}, data: [...fold().values()].map(record => record.provider) })),
  }
  const registration = vi.fn(async (callback: (editor: any) => void) => { callback({ namespace: vi.fn(), add: (tool: any) => tools.set(tool.name, tool) }); return { dispose: vi.fn(async () => {}) } })
  const event = { subscribe: ({ signal }: { signal: AbortSignal }) => ({ async *[Symbol.asyncIterator]() { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })) } }) }
  const ctx = { options: { modelsDev: false, ...(options as object) }, provider, tool: { transform: registration }, command: { transform: registration }, event, storage: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) }, integration: { connection: { active: vi.fn(async () => undefined), resolve: vi.fn(async () => undefined) } } }
  return { ctx, tools, record: (id: string) => fold().get(id) }
}
const fetcher = () => vi.fn(async (url: any) => new Response(JSON.stringify({ data: [{ id: "mine" }, { id: "found" }] }), { status: 200, headers: { "content-type": "application/json", "x-url": String(url) } }))
const hosts = (mock: ReturnType<typeof fetcher>) => [...new Set(mock.mock.calls.map(call => new URL(String(call[0])).host))].sort()

describe("built-in providers", () => {
  it("recognises catalog providers and leaves canonical-backed custom providers alone", () => {
    expect(looksBuiltin({ provider: { id: "opencode-go" }, models: new Map() } as never)).toBe(true)
    expect(looksBuiltin({ provider: { id: "x" }, models: new Map([["a", model("x", "a", { cost: [{ input: 1 }] })]]) } as never)).toBe(true)
    expect(looksBuiltin({ provider: { id: "x" }, models: new Map([["a", model("x", "a")]]) } as never)).toBe(false)
    expect(looksBuiltin({ provider: { id: "x", package: "aisdk:@ai-sdk/openai-compatible" }, models: new Map([["a", model("x", "a", { family: "gpt" })]]) } as never)).toBe(false)
    expect(looksBuiltin({ provider: { id: "x", canonical: "openai" }, models: new Map([["a", model("x", "a", { family: "gpt" })]]) } as never)).toBe(false)
  })

  it("never queries or rewrites built-in providers by default", async () => {
    const mock = fetcher(); vi.stubGlobal("fetch", mock)
    const { ctx, record, tools } = host()
    const cleanup = await plugin.setup(ctx as never)
    expect(hosts(mock)).toEqual(["gw.example"])
    expect([...record("opencode").models.keys()]).toEqual(["zen-big"])
    expect([...record("lookalike").models.keys()]).toEqual(["cat-1"])
    expect([...record("gw").models.keys()].sort()).toEqual(["found", "mine"])
    const report = JSON.parse((await tools.get("status").execute({}, {})).content)
    expect(report.filter((item: any) => item.mode === "skipped").map((item: any) => [item.endpoint, item.reason]).sort()).toEqual([["lookalike", "built-in provider"], ["opencode", "built-in provider"]])
    await cleanup?.()
  })

  it("keeps the runtime the user or OpenChamber chose", async () => {
    vi.stubGlobal("fetch", fetcher())
    const { ctx, record } = host()
    const cleanup = await plugin.setup(ctx as never)
    const gw = record("gw")
    expect(gw.provider.package).toBe("aisdk:@ai-sdk/openai-compatible")
    expect(gw.models.get("mine")).toMatchObject({ package: "aisdk:@ai-sdk/anthropic", settings: { baseURL: "https://gw.example/anthropic" } })
    expect(gw.models.get("found").package).toBeUndefined()
    await cleanup?.()
  })

  it("does not replace an existing provider when an explicit endpoint reuses its ID", async () => {
    vi.stubGlobal("fetch", fetcher())
    const { ctx, record } = host({ endpoints: [{ id: "gw", baseURL: "https://gw.example/v1", protocol: "anthropic-compatible" }] })
    const cleanup = await plugin.setup(ctx as never)
    const gw = record("gw")
    expect(gw.provider.package).toBe("aisdk:@ai-sdk/openai-compatible")
    expect(gw.provider.name).toBe("Gateway")
    expect(gw.models.get("mine").package).toBe("aisdk:@ai-sdk/anthropic")
    expect([...gw.models.keys()].sort()).toEqual(["found", "mine"])
    await cleanup?.()
  })

  it("opts built-in providers back in per provider, by list, or globally", async () => {
    for (const [options, zen, expected] of [
      [{}, { modelsDiscovery: { enabled: true } }, ["gw.example", "zen.example"]],
      [{ auto: { providers: ["opencode"] } }, {}, ["zen.example"]],
      [{ auto: { builtin: true } }, {}, ["gw.example", "lookalike.example", "zen.example"]],
    ] as const) {
      const mock = fetcher(); vi.stubGlobal("fetch", mock)
      const { ctx, record } = host(options, zen)
      const cleanup = await plugin.setup(ctx as never)
      expect(hosts(mock)).toEqual(expected)
      // Even when opted in, a catalog model keeps its own runtime.
      expect(record("opencode").models.get("zen-big").package).toBe("@opencode/ai/providers/anthropic")
      await cleanup?.()
    }
  })
})
