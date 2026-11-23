import { afterEach, describe, expect, it, vi } from "vitest"
import plugin from "../src/index.js"
import { matchHostModel, parsePluginOptions } from "../src/plugin.js"

afterEach(() => vi.restoreAllMocks())

describe("plugin surface", () => {
  it("matches host catalog identities and settles shared names by provider, then by consensus", () => {
    const model = (providerID: string, id: string, canonical?: string) => ({ id, modelID: id, providerID, canonical, variants: [], name: id }) as any
    const records = [
      { provider: { id: "openai" } as any, models: new Map([["gpt-5", model("openai", "gpt-5", "openai")]]) },
      { provider: { id: "other" } as any, models: new Map([["same", model("other", "same")]]) },
      { provider: { id: "third" } as any, models: new Map([["same", model("third", "same")]]) },
    ]
    expect(matchHostModel("openai/gpt-5", records)?.modelID).toBe("gpt-5")
    expect(matchHostModel("gateway/openai/gpt-5", records)?.modelID).toBe("gpt-5")
    expect(matchHostModel("GPT_5", records)?.modelID).toBe("gpt-5")
    // Two catalog providers carry the same model: the one named in the gateway ID wins, otherwise the common (or smaller) context.
    const sized = (providerID: string, context: number) => ({ ...model(providerID, "same"), limit: { context, output: 1 } })
    const shared = [
      { provider: { id: "other" } as any, models: new Map([["same", sized("other", 200_000)]]) },
      { provider: { id: "third" } as any, models: new Map([["same", sized("third", 128_000)]]) },
      { provider: { id: "fourth" } as any, models: new Map([["same", sized("fourth", 200_000)]]) },
    ]
    expect(matchHostModel("same", shared)?.limit.context).toBe(200_000)
    expect(matchHostModel("gw/third/same", shared)?.providerID).toBe("third")
    expect(matchHostModel("gw/same", shared.slice(0, 2))?.limit.context).toBe(128_000)
    // A suffix is part of the name: it is never removed to reach the base model.
    expect(matchHostModel("gw/same:free", shared)).toBeUndefined()
    expect(matchHostModel("gw/same-free", shared)).toBeUndefined()
    expect(matchHostModel("gw/same-latest", shared)).toBeUndefined()
    expect(matchHostModel("gpt-5-plus", records)).toBeUndefined()
  })

  it("preserves protocol-correct variants from the matched host catalog model", () => {
    const variants = [
      { id: "low", settings: { reasoningEffort: "low" }, headers: { "x-mode": "reasoning" } },
      { id: "max", body: { reasoning: { effort: "max" } } },
    ]
    const catalog = {
      id: "kimi-k3", modelID: "kimi-k3", providerID: "moonshotai", canonical: "moonshotai", name: "Kimi K3",
      package: "@opencode/ai/providers/moonshot", settings: { baseURL: "https://api.moonshot.ai/v1" }, body: { providerOnly: true },
      variants, capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, limit: { context: 1_048_576, output: 131_072 },
    } as any
    const matched = matchHostModel("relay.example/moonshotai/kimi-k3", [{ provider: { id: "moonshotai" } as any, models: new Map([["kimi-k3", catalog]]) }])
    expect(matched?.variants).toEqual(variants)
  })
  it("exports an OpenCode V2 plugin definition without running setup", () => {
    expect(plugin).toMatchObject({ id: "custom-api" })
    expect(typeof plugin.setup).toBe("function")
  })

  it("uses a versioned inventory key so metadata resolver upgrades re-normalize cached models", async () => {
    const storage = { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) }
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200, headers: { "content-type": "application/json" } })))
    const transforms = vi.fn(async (callback: (editor: any) => void) => { callback({ list: () => [], get: vi.fn(), add: vi.fn(), update: vi.fn(), namespace: vi.fn(), models: { set: vi.fn() } }); return { dispose: vi.fn(async () => {}) } })
    const event = { subscribe: ({ signal }: { signal: AbortSignal }) => ({ async *[Symbol.asyncIterator]() { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })) } }) }
    const cleanup = await plugin.setup({ options: { endpoints: [{ id: "cache-key", baseURL: "https://cache.example/v1", protocol: "openai-compatible" }] }, provider: { transform: transforms, list: vi.fn(async () => ({ location: {}, data: [] })) }, model: { transform: transforms }, tool: { transform: transforms }, command: { transform: transforms }, event, storage, integration: { connection: { active: vi.fn(), resolve: vi.fn() } } } as never)
    expect(storage.get).toHaveBeenCalledWith("inventory/v3/cache-key")
    await cleanup?.()
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

  it("reconciles providers first observed by a deferred transform execution", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "late-model" }] }), { status: 200, headers: { "content-type": "application/json" } })))
    const providerTransforms: ((editor: any) => void)[] = []
    let providerGapObserved = false
    const foldProviders = () => {
      const records = new Map<string, any>()
      const editor = {
        list: () => [...records.values()],
        get: (id: string) => records.get(id),
        add: ({ info, models }: any) => records.set(info.id, { provider: info, models: new Map(models.map((model: any) => [model.id, model])) }),
        models: { set: (id: string, models: any[]) => {
          const record = records.get(id)
          if (record) record.models = new Map(models.map(model => [model.id, model]))
        } },
      }
      for (const callback of providerTransforms) callback(editor)
      return [...records.values()]
    }
    const providerReload = vi.fn(async () => {})
    const provider = {
      transform: vi.fn(async (callback: (editor: any) => void) => {
        providerTransforms.push(callback)
        foldProviders()
        return { dispose: async () => {
          const index = providerTransforms.indexOf(callback)
          if (index >= 0) providerTransforms.splice(index, 1)
          if (!providerTransforms.length) providerGapObserved = true
          foldProviders()
        } }
      }),
      list: vi.fn(async () => ({ location: {}, data: foldProviders().map(record => record.provider) })),
      reload: providerReload,
    }
    const registrationTransform = vi.fn(async (callback: (editor: any) => void) => {
      callback({ add: vi.fn(), namespace: vi.fn() })
      return { dispose: vi.fn(async () => {}) }
    })
    const modelTransforms = new Set<(editor: any) => void>()
    const modelEditor = { update: vi.fn() }
    const modelTransform = vi.fn(async (callback: (editor: any) => void) => {
      modelTransforms.add(callback)
      for (const transform of modelTransforms) transform(modelEditor)
      return { dispose: async () => {
        modelTransforms.delete(callback)
        for (const transform of modelTransforms) transform(modelEditor)
      } }
    })
    const modelReload = vi.fn(async () => {})
    const events: any[] = []
    let wake: (() => void) | undefined
    const emit = (event: any) => { events.push(event); wake?.(); wake = undefined }
    const event = {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            if (!events.length) await new Promise<void>(resolve => {
              wake = resolve
              signal.addEventListener("abort", () => resolve(), { once: true })
            })
            while (events.length) yield events.shift()
          }
        },
      }),
    }
    const cleanup = await plugin.setup({
      options: {}, provider, model: { transform: modelTransform, reload: modelReload }, tool: { transform: registrationTransform }, command: { transform: registrationTransform }, event,
      storage: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
      integration: { connection: { active: vi.fn(async () => undefined), resolve: vi.fn() } },
    } as never)

    const laterTransform = (editor: any) => editor.add({
      info: { id: "late", name: "Late", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://late.example/v1" } },
      models: [],
    })
    providerTransforms.push(laterTransform)
    expect(foldProviders().find(record => record.provider.id === "late")?.models.size).toBe(0)
    emit({ type: "provider.updated" })

    await vi.waitFor(() => expect([...foldProviders().find(record => record.provider.id === "late")!.models.keys()]).toContain("late-model"))
    expect(providerTransforms.at(-1)).not.toBe(laterTransform)
    expect(providerGapObserved).toBe(false)
    expect(provider.list).toHaveBeenCalled()
    expect(providerReload).not.toHaveBeenCalled()
    expect(modelReload).not.toHaveBeenCalled()
    await cleanup?.()
  })

  it("hydrates providers visible during setup before setup returns", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "ready-model" }] }), { status: 200, headers: { "content-type": "application/json" } })))
    const transforms: ((editor: any) => void)[] = []
    const fold = () => {
      const records = new Map<string, any>()
      const editor = {
        get: (id: string) => records.get(id),
        list: () => [...records.values()],
        add: ({ info, models }: any) => records.set(info.id, { provider: info, models: new Map(models.map((model: any) => [model.id, model])) }),
        models: { set: (id: string, models: any[]) => { const record = records.get(id); if (record) record.models = new Map(models.map(model => [model.id, model])) } },
      }
      for (const transform of transforms) transform(editor)
      return [...records.values()]
    }
    transforms.push(editor => editor.add({
      info: { id: "ready", name: "Ready", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://ready.example/v1" } },
      models: [],
    }))
    const provider = {
      transform: vi.fn(async (callback: (editor: any) => void) => {
        transforms.push(callback)
        fold()
        return { dispose: async () => { const index = transforms.indexOf(callback); if (index >= 0) transforms.splice(index, 1); fold() } }
      }),
      list: vi.fn(async () => ({ location: {}, data: fold().map(record => record.provider) })),
    }
    const disposableTransform = vi.fn(async (callback: (editor: any) => void) => {
      callback({ add: vi.fn(), namespace: vi.fn(), update: vi.fn() })
      return { dispose: vi.fn(async () => {}) }
    })
    const event = { subscribe: ({ signal }: { signal: AbortSignal }) => ({ async *[Symbol.asyncIterator]() { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })) } }) }
    const cleanup = await plugin.setup({
      options: {}, provider, model: { transform: disposableTransform }, tool: { transform: disposableTransform }, command: { transform: disposableTransform }, event,
      storage: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
      integration: { connection: { active: vi.fn(async () => undefined), resolve: vi.fn() } },
    } as never)

    expect([...fold().find(record => record.provider.id === "ready")!.models.keys()]).toContain("ready-model")
    await cleanup?.()
  })

  it("exposes reasoning effort variants instead of forcing reasoning history compatibility", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }, { id: "moonshotai/kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } })))
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
    transforms.push(editor => editor.add({ info: { id: "reasoning", name: "Reasoning", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://reasoning.example/v1" } }, models: [] }))
    const provider = {
      transform: vi.fn(async (callback: (editor: any) => void) => { transforms.push(callback); fold(); return { dispose: async () => { const i = transforms.indexOf(callback); if (i >= 0) transforms.splice(i, 1); fold() } } }),
      list: vi.fn(async () => ({ location: {}, data: fold().map(record => record.provider) })),
    }
    const modelDrafts: any[] = []
    const passiveTransform = vi.fn(async (callback: (editor: any) => void) => { callback({ add: vi.fn(), namespace: vi.fn(), update: (_provider: string, _model: string, edit: (draft: any) => void) => { const draft: any = {}; edit(draft); modelDrafts.push(draft) } }); return { dispose: vi.fn(async () => {}) } })
    const event = { subscribe: ({ signal }: { signal: AbortSignal }) => ({ async *[Symbol.asyncIterator]() { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })) } }) }
    const cleanup = await plugin.setup({ options: {}, provider, model: { transform: passiveTransform }, tool: { transform: passiveTransform }, command: { transform: passiveTransform }, event, storage: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) }, integration: { connection: { active: vi.fn(async () => undefined), resolve: vi.fn() } } } as never)

    const model = fold().find(record => record.provider.id === "reasoning")!.models.get("gpt-5.6-sol")
    expect(model.variants.map((variant: any) => [variant.id, variant.settings.reasoningEffort])).toEqual([["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"]])
    expect(model.compatibility?.requireReasoning).toBeUndefined()
    const kimi = fold().find(record => record.provider.id === "reasoning")!.models.get("moonshotai/kimi-k3")
    expect(kimi.variants.map((variant: any) => [variant.id, variant.settings.reasoningEffort])).toEqual([["low", "low"], ["high", "high"], ["max", "max"]])
    expect(modelDrafts).toEqual([])
    await cleanup?.()
  })

  it("enriches a namespaced custom model from host variants without copying the host route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "relay.example/moonshotai/kimi-k3" }] }), { status: 200, headers: { "content-type": "application/json" } })))
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
      info: { id: "moonshotai", name: "Moonshot", activation: "disabled", package: "@opencode/ai/providers/moonshot", settings: { baseURL: "https://api.moonshot.ai/v1" } },
      models: [{ ...({ id: "kimi-k3", modelID: "kimi-k3", providerID: "moonshotai", canonical: "moonshotai", name: "Kimi K3", package: "@opencode/ai/providers/moonshot", settings: { baseURL: "https://api.moonshot.ai/v1" }, capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, variants: [{ id: "max", body: { reasoning: { effort: "max" } } }], time: { released: 0 }, cost: [], status: "active", enabled: true, limit: { context: 1_048_576, output: 131_072 } } as any) }],
    }))
    transforms.push(editor => editor.add({ info: { id: "custom", name: "Custom", activation: "enabled", package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: "https://relay.example/v1" } }, models: [] }))
    const provider = {
      transform: vi.fn(async (callback: (editor: any) => void) => { transforms.push(callback); fold(); return { dispose: async () => { const i = transforms.indexOf(callback); if (i >= 0) transforms.splice(i, 1); fold() } } }),
      list: vi.fn(async () => ({ location: {}, data: fold().map(record => record.provider) })),
    }
    const passive = vi.fn(async (callback: (editor: any) => void) => { callback({ add: vi.fn(), namespace: vi.fn(), update: vi.fn() }); return { dispose: vi.fn(async () => {}) } })
    const event = { subscribe: ({ signal }: { signal: AbortSignal }) => ({ async *[Symbol.asyncIterator]() { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })) } }) }
    const cleanup = await plugin.setup({ options: {}, provider, model: { transform: passive }, tool: { transform: passive }, command: { transform: passive }, event, storage: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) }, integration: { connection: { active: vi.fn(async () => undefined), resolve: vi.fn() } } } as never)

    const model = fold().find(record => record.provider.id === "custom")!.models.get("relay.example/moonshotai/kimi-k3")
    expect(model.variants).toEqual([{ id: "max", body: { reasoning: { effort: "max" } } }])
    expect(model.package).toBeUndefined()
    expect(model.settings).toBeUndefined()
    expect(model.providerID).toBe("custom")
    await cleanup?.()
  })
})
