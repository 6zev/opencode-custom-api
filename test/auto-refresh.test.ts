import { afterEach, describe, expect, it, vi } from "vitest"
import plugin from "../src/index.js"

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

/** Minimal host: one configured provider with a hand-written model, plus the plugin's own transforms. */
function host(settings: Record<string, unknown>, options: unknown = {}) {
  const transforms: ((editor: any) => void)[] = []
  const fold = () => {
    const records = new Map<string, any>()
    const editor = {
      get: (id: string) => records.get(id), list: () => [...records.values()],
      add: ({ info, models }: any) => records.set(info.id, { provider: info, models: new Map(models.map((model: any) => [model.id, model])) }),
      models: { set: (id: string, models: any[]) => { const record = records.get(id); if (record) record.models = new Map(models.map(model => [model.id, model])) } },
    }
    for (const transform of transforms) transform(editor)
    return [...records.values()]
  }
  transforms.push(editor => editor.add({
    info: { id: "gw", name: "Gateway", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://gw.example/v1", ...settings } },
    models: [{ id: "hand-written", modelID: "hand-written", providerID: "gw", name: "Hand written", variants: [], capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 1000, output: 100 } }],
  }))
  const tools = new Map<string, any>()
  const provider = {
    transform: vi.fn(async (callback: (editor: any) => void) => { transforms.push(callback); fold(); return { dispose: async () => { const i = transforms.indexOf(callback); if (i >= 0) transforms.splice(i, 1); fold() } } }),
    list: vi.fn(async () => ({ location: {}, data: fold().map(record => record.provider) })),
  }
  const registration = vi.fn(async (callback: (editor: any) => void) => { callback({ namespace: vi.fn(), add: (tool: any) => tools.set(tool.name, tool) }); return { dispose: vi.fn(async () => {}) } })
  const event = { subscribe: ({ signal }: { signal: AbortSignal }) => ({ async *[Symbol.asyncIterator]() { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })) } }) }
  const ctx = { options: { modelsDev: false, ...(options as object) }, provider, tool: { transform: registration }, command: { transform: registration }, event, storage: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) }, integration: { connection: { active: vi.fn(async () => undefined), resolve: vi.fn() } } }
  const ids = () => [...fold().find(record => record.provider.id === "gw")!.models.keys()].sort()
  return { ctx, ids, tools, provider }
}
const respond = (...ids: string[]) => new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), { status: 200, headers: { "content-type": "application/json" } })

describe("automatic operation", () => {
  it("re-discovers auto-detected providers in the background without a manual refresh", async () => {
    vi.useFakeTimers()
    let listed = ["a"]
    const fetcher = vi.fn(async () => respond(...listed))
    vi.stubGlobal("fetch", fetcher)
    const { ctx, ids, provider } = host({ modelsDiscovery: { refreshIntervalMs: 60_000 } })
    const cleanup = await plugin.setup(ctx as never)
    // The placeholder typed in to create the provider is not upstream, so it is dropped.
    expect(ids()).toEqual(["a"])
    const registrations = provider.transform.mock.calls.length

    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    // Nothing changed upstream, so the provider overlay is not re-registered.
    expect(provider.transform.mock.calls.length).toBe(registrations)

    listed = ["a", "b"]
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ids()).toEqual(["a", "b"])

    // Upstream removes a model: it disappears here too.
    listed = ["b"]
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ids()).toEqual(["b"])

    // An outage keeps the last inventory instead of throwing or emptying the provider.
    vi.spyOn(console, "warn").mockImplementation(() => {})
    fetcher.mockImplementation(async () => new Response("down", { status: 502 }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ids()).toEqual(["b"])

    await cleanup?.()
    const calls = fetcher.mock.calls.length
    await vi.advanceTimersByTimeAsync(180_000)
    expect(fetcher.mock.calls.length).toBe(calls)
  })

  it("prunes models the gateway no longer lists only when asked, and never on an empty or failed inventory", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond("a", "b-preview")))
    const pruned = host({ modelsDiscovery: { exclude: ["preview$"], refreshIntervalMs: 0 } })
    const cleanupPruned = await plugin.setup(pruned.ctx as never)
    expect(pruned.ids()).toEqual(["a"])
    await cleanupPruned?.()

    const kept = host({ modelsDiscovery: { pruneMissing: false, refreshIntervalMs: 0 } })
    const cleanupKept = await plugin.setup(kept.ctx as never)
    expect(kept.ids()).toEqual(["a", "b-preview", "hand-written"])
    await cleanupKept?.()

    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 502 })))
    const failing = host({ modelsDiscovery: { refreshIntervalMs: 0 } })
    const cleanupFailing = await plugin.setup(failing.ctx as never)
    expect(failing.ids()).toEqual(["hand-written"])
    await cleanupFailing?.()
  })

  it("honours plugin-level auto defaults and reports status without a network call", async () => {
    const fetcher = vi.fn(async () => respond("gpt-x", "claude-y"))
    vi.stubGlobal("fetch", fetcher)
    const { ctx, ids, tools } = host({}, { auto: { include: ["^gpt"], refreshIntervalMs: 0 } })
    const cleanup = await plugin.setup(ctx as never)
    expect(ids()).toEqual(["gpt-x"])
    const calls = fetcher.mock.calls.length
    const report = JSON.parse((await tools.get("status").execute({}, {})).content)
    expect(fetcher.mock.calls.length).toBe(calls)
    expect(report).toHaveLength(1)
    expect(report[0]).toMatchObject({ endpoint: "gw", mode: "auto", models: 1, stale: false, refreshIntervalMs: 0, include: ["^gpt"], pruneMissing: true })
    expect(typeof report[0].refreshedAt).toBe("string")
    expect(JSON.stringify(report)).not.toContain("apiKey")
    await cleanup?.()

    const off = host({}, { auto: { enabled: false } })
    const cleanupOff = await plugin.setup(off.ctx as never)
    expect(off.ids()).toEqual(["hand-written"])
    await cleanupOff?.()
  })
})

describe("host-side overlays", () => {
  it("removes a config placeholder the host layers on top of the inventory", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond("a", "b")))
    const { ctx } = host({ modelsDiscovery: { refreshIntervalMs: 0 } })
    // The host keeps config models as overrides: they survive models.set and are appended after the inventory.
    const overlay = ["placeholder", "a"]
    const transforms: ((editor: any) => void)[] = []
    const visible = () => {
      const ids = ["a", "b", ...overlay.filter(id => id !== "a")]
      const removed = new Set<string>()
      for (const transform of transforms) transform({ list: () => ids.map(id => ({ id, modelID: id })), remove: (_: string, id: string) => removed.add(id) })
      return ids.filter(id => !removed.has(id))
    }
    const reload = vi.fn(async () => {})
    ;(ctx as any).model = { transform: vi.fn(async (callback: any) => { transforms.push(callback); return { dispose: async () => { transforms.splice(transforms.indexOf(callback), 1) } } }), reload }
    const cleanup = await plugin.setup(ctx as never)
    expect(visible()).toEqual(["a", "b"])
    expect(transforms).toHaveLength(1)
    expect(reload).not.toHaveBeenCalled()
    await (cleanup as () => Promise<void>)()
  })

  it("looks at the provider registry again when a workspace lists its providers late", async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async () => respond("a"))
    vi.stubGlobal("fetch", fetcher)
    const { ctx, ids, provider } = host({ modelsDiscovery: { refreshIntervalMs: 0 } })
    const real = provider.list.getMockImplementation()!
    let ready = false
    provider.list.mockImplementation(async () => ready ? real() : { location: {}, data: [] })
    const cleanup = await plugin.setup(ctx as never)
    expect(fetcher).not.toHaveBeenCalled()
    ready = true
    await vi.advanceTimersByTimeAsync(5_000)
    expect(ids()).toEqual(["a"])
    await (cleanup as () => Promise<void>)()
  })
})
