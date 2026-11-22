import { afterEach, describe, expect, it, vi } from "vitest"
import plugin from "../src/index.js"
import { parsePluginOptions } from "../src/plugin.js"

afterEach(() => vi.restoreAllMocks())

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
})
