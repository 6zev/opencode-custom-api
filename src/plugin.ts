import { Model, Plugin, Provider } from "@opencode/plugin"
import type { Plugin as PluginTypes } from "@opencode/plugin"
import { discover } from "./discovery.js"
import { loadWithCache } from "./cache.js"
import { normalizeModel } from "./normalize.js"
import type { DiscoveredModel, EndpointOptions, PluginOptions } from "./types.js"

type Context = PluginTypes.Context
interface Source { endpoint: EndpointOptions; models: DiscoveredModel[]; stale: boolean }

const validDuration = (value: unknown, allowZero: boolean) => typeof value === "number" && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)

export function parsePluginOptions(value: unknown): PluginOptions {
  if (!value || typeof value !== "object" || !Array.isArray((value as PluginOptions).endpoints)) throw new Error("custom-api: options.endpoints must be an array")
  const endpoints = (value as PluginOptions).endpoints
  const ids = new Set<string>()
  for (const endpoint of endpoints) {
    if (!endpoint || typeof endpoint.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(endpoint.id)) throw new Error("custom-api: each endpoint needs a valid id")
    if (ids.has(endpoint.id)) throw new Error(`custom-api: duplicate endpoint id ${endpoint.id}`)
    ids.add(endpoint.id)
    if (typeof endpoint.baseURL !== "string" || !/^https?:\/\//.test(endpoint.baseURL)) throw new Error(`custom-api: ${endpoint.id}.baseURL must be an HTTP(S) URL`)
    if (endpoint.protocol !== "openai-compatible" && endpoint.protocol !== "anthropic-compatible") throw new Error(`custom-api: ${endpoint.id}.protocol is invalid`)
    if (endpoint.apiKey && (typeof endpoint.apiKey.env !== "string" || !endpoint.apiKey.env)) throw new Error(`custom-api: ${endpoint.id}.apiKey must be { env: "NAME" }`)
    if (endpoint.timeoutMs !== undefined && !validDuration(endpoint.timeoutMs, false)) throw new Error(`custom-api: ${endpoint.id}.timeoutMs must be finite and positive`)
    if (endpoint.cacheTtlMs !== undefined && !validDuration(endpoint.cacheTtlMs, true)) throw new Error(`custom-api: ${endpoint.id}.cacheTtlMs must be finite and nonnegative`)
    if (endpoint.refreshIntervalMs !== undefined && !validDuration(endpoint.refreshIntervalMs, true)) throw new Error(`custom-api: ${endpoint.id}.refreshIntervalMs must be finite and nonnegative`)
  }
  return { endpoints }
}

function runtimeHeaders(endpoint: EndpointOptions): Record<string, string> {
  const headers: Record<string, string> = {}
  if (endpoint.apiKey) {
    const key = process.env[endpoint.apiKey.env]
    if (key) endpoint.protocol === "anthropic-compatible" ? headers["x-api-key"] = key : headers.Authorization = `Bearer ${key}`
  }
  for (const [name, reference] of Object.entries(endpoint.headers ?? {})) {
    const value = typeof reference === "string" ? reference : process.env[reference.env]
    if (value !== undefined) headers[name] = value
  }
  return headers
}

function toModel(providerID: Provider.ID, value: DiscoveredModel): Model.Info {
  return {
    ...Model.Info.default(providerID, Model.ID.make(value.id)),
    name: value.name,
    type: value.type,
    limit: { context: value.context, output: value.output },
    capabilities: { tools: value.tools, input: value.input, output: ["text"] },
    compatibility: value.reasoning ? { requireReasoning: true } : undefined,
  }
}

async function readSource(ctx: Context, endpoint: EndpointOptions, force = false, signal?: AbortSignal): Promise<Source> {
  const load = async () => (await discover(endpoint, signal)).map(raw => normalizeModel(raw, endpoint.catalog)).filter((item): item is DiscoveredModel => item !== undefined)
  const cache = await loadWithCache(
    { get: key => ctx.storage.get(key), set: (key, value) => ctx.storage.set(key, value as never) },
    `inventory/v1/${endpoint.id}`,
    force ? 0 : endpoint.cacheTtlMs ?? 300_000,
    load,
  )
  return { endpoint, ...cache }
}

export default Plugin.define({
  id: "custom-api",
  async setup(ctx) {
    const config = parsePluginOptions(ctx.options)
    const controllers = new Set<AbortController>()
    const sources: Source[] = []
    for (const endpoint of config.endpoints) sources.push(await readSource(ctx, endpoint))

    const providerRegistration = await ctx.provider.transform(editor => {
      for (const source of sources) {
        const endpoint = source.endpoint
        const id = Provider.ID.make(endpoint.id)
        editor.add({
          info: {
            ...Provider.Info.empty(id),
            name: endpoint.name ?? endpoint.id,
            activation: "enabled",
            package: endpoint.protocol === "anthropic-compatible" ? "@opencode/ai/providers/anthropic-compatible" : "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: endpoint.baseURL, timeout: endpoint.timeoutMs ?? 10_000 },
            headers: runtimeHeaders(endpoint),
          },
          models: source.models.map(model => toModel(id, model)),
        })
      }
    })

    // V2 has no `capabilities.reasoning` field. Preserve discovered reasoning through
    // the official compatibility flag in a model transform.
    const modelRegistration = await ctx.model.transform(editor => {
      for (const source of sources) for (const model of source.models) {
        if (!model.reasoning) continue
        editor.update(source.endpoint.id, model.id, draft => { draft.compatibility = { ...draft.compatibility, requireReasoning: true } })
      }
    })

    const refresh = async (only?: string, signal?: AbortSignal) => {
      const selected = sources.filter(source => !only || source.endpoint.id === only)
      if (only && selected.length === 0) throw new Error(`Unknown endpoint: ${only}`)
      await Promise.all(selected.map(async source => {
        const next = await readSource(ctx, source.endpoint, true, signal)
        source.models = next.models
        source.stale = next.stale
      }))
      await ctx.provider.reload()
      await ctx.model.reload()
      return selected.map(source => ({ endpoint: source.endpoint.id, models: source.models.length, stale: source.stale }))
    }

    const toolRegistration = await ctx.tool.transform(editor => {
      editor.namespace({ name: "custom_api", description: "Custom API endpoint inventory management" })
      editor.add({
        name: "refresh",
        description: "Refresh custom endpoint model inventories. Optionally restrict to one endpoint ID.",
        input: { type: "object", properties: { endpoint: { type: "string" } }, additionalProperties: false },
        options: { namespace: "custom_api", codemode: false },
        execute: async (input, context) => ({ content: JSON.stringify(await refresh((input as { endpoint?: string }).endpoint, context.signal)) }),
      })
    })
    const commandRegistration = await ctx.command.transform(editor => editor.add({
      name: "custom-api-refresh",
      description: "Refresh every custom API model inventory",
      execute: async () => { await refresh() },
    }))

    const timers = sources.flatMap(source => source.endpoint.refreshIntervalMs && source.endpoint.refreshIntervalMs > 0 ? [setInterval(() => {
      const controller = new AbortController(); controllers.add(controller)
      void refresh(source.endpoint.id, controller.signal).catch(console.error).finally(() => controllers.delete(controller))
    }, source.endpoint.refreshIntervalMs)] : [])

    return async () => {
      timers.forEach(clearInterval)
      controllers.forEach(controller => controller.abort())
      await Promise.all([providerRegistration.dispose(), modelRegistration.dispose(), toolRegistration.dispose(), commandRegistration.dispose()])
    }
  },
})
