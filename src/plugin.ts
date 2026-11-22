import { Model, Plugin, Provider } from "@opencode/plugin"
import type { Plugin as PluginTypes } from "@opencode/plugin"
import { discover } from "./discovery.js"
import { loadWithCache } from "./cache.js"
import { normalizeModel } from "./normalize.js"
import { autoEndpointFromProvider, credentialSecret, mergeDiscoveredModels, type AutoEndpoint } from "./autodiscovery.js"
import type { DiscoveredModel, EndpointOptions, PluginOptions } from "./types.js"

type Context = PluginTypes.Context
interface Source {
  endpoint: EndpointOptions
  models: DiscoveredModel[]
  stale: boolean
  auto?: AutoEndpoint
}

interface AutoCandidate {
  auto: AutoEndpoint
  fingerprint: string
}

const validDuration = (value: unknown, allowZero: boolean) => typeof value === "number" && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)

export function parsePluginOptions(value: unknown): PluginOptions {
  if (value === undefined || value === null) return { endpoints: [] }
  if (typeof value !== "object") throw new Error("custom-api: options must be an object")
  if (!("endpoints" in value)) return { endpoints: [] }
  if (!Array.isArray((value as PluginOptions).endpoints)) throw new Error("custom-api: options.endpoints must be an array")
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

async function readSource(ctx: Context, endpoint: EndpointOptions, force = false, signal?: AbortSignal, credential?: string): Promise<Source> {
  const load = async () => (await discover(endpoint, signal, fetch, credential)).map(raw => normalizeModel(raw, endpoint.catalog)).filter((item): item is DiscoveredModel => item !== undefined)
  const cache = await loadWithCache(
    { get: key => ctx.storage.get(key), set: (key, value) => ctx.storage.set(key, value as never) },
    `inventory/v1/${endpoint.id}`,
    force ? 0 : endpoint.cacheTtlMs ?? 300_000,
    load,
  )
  return { endpoint, ...cache }
}

async function resolveAutoCredential(ctx: Context, source: AutoEndpoint): Promise<string | undefined> {
  if (!source.integrationID) return source.settingsApiKey
  const connection = await ctx.integration.connection.active(source.integrationID)
  if (!connection) return source.settingsApiKey
  const credential = await ctx.integration.connection.resolve(connection)
  return credentialSecret(credential, source.settingsApiKey)
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]))
}

function fingerprint(provider: Provider.Info, auto: AutoEndpoint): string {
  return JSON.stringify(stableValue({
    id: provider.id,
    name: provider.name,
    package: provider.package,
    settings: provider.settings,
    headers: provider.headers,
    integrationID: auto.integrationID,
    settingsApiKey: auto.settingsApiKey,
  }))
}

function sourceState(source: Source): string {
  return JSON.stringify(stableValue({ endpoint: source.endpoint, models: source.models, stale: source.stale, auto: source.auto }))
}

export default Plugin.define({
  id: "custom-api",
  async setup(ctx) {
    const config = parsePluginOptions(ctx.options)
    const controllers = new Set<AbortController>()
    const lifecycle = new AbortController()
    const explicit = new Map<string, Source>(config.endpoints.map(endpoint => [endpoint.id, { endpoint, models: [], stale: true }]))
    const automatic = new Map<string, Source>()
    const sources = () => [...explicit.values(), ...automatic.values()]
    const configured = new Set(config.endpoints.map(endpoint => endpoint.id))
    let candidates = new Map<string, AutoCandidate>()
    let reconciled = new Map<string, string>()
    let providerInventory = ""
    let explicitLoaded = false
    let queue = Promise.resolve()
    let forceReconcile = false
    let queued = false

    const applyProviders = (editor: Parameters<Parameters<typeof ctx.provider.transform>[0]>[0]) => {
      for (const source of sources()) {
        const endpoint = source.endpoint
        const id = Provider.ID.make(endpoint.id)
        const discovered = source.models.map(model => toModel(id, model))
        if (source.auto) {
          editor.models.set(endpoint.id, mergeDiscoveredModels(discovered, editor.get(endpoint.id)?.models ?? new Map()))
          continue
        }
        editor.add({
          info: {
            ...Provider.Info.empty(id),
            name: endpoint.name ?? endpoint.id,
            activation: "enabled",
            package: endpoint.protocol === "anthropic-compatible" ? "@opencode/ai/providers/anthropic-compatible" : "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: endpoint.baseURL, timeout: endpoint.timeoutMs ?? 10_000 },
            headers: runtimeHeaders(endpoint),
          },
          models: discovered,
        })
      }
    }
    const applyModels = (editor: Parameters<Parameters<typeof ctx.model.transform>[0]>[0]) => {
      for (const source of sources()) for (const model of source.models) {
        if (!model.reasoning) continue
        editor.update(source.endpoint.id, model.id, draft => { draft.compatibility = { ...draft.compatibility, requireReasoning: true } })
      }
    }

    let providerRegistration = await ctx.provider.transform(applyProviders)
    let modelRegistration = await ctx.model.transform(applyModels)

    const registerAtTail = async () => {
      if (lifecycle.signal.aborted) return
      const nextProviderRegistration = await ctx.provider.transform(applyProviders)
      if (lifecycle.signal.aborted) return nextProviderRegistration.dispose()
      const previousProviderRegistration = providerRegistration
      providerRegistration = nextProviderRegistration
      await previousProviderRegistration.dispose()
      const nextModelRegistration = await ctx.model.transform(applyModels)
      if (lifecycle.signal.aborted) return nextModelRegistration.dispose()
      const previousModelRegistration = modelRegistration
      modelRegistration = nextModelRegistration
      await previousModelRegistration.dispose()
    }

    const reconcile = async () => {
      const listed = await ctx.provider.list()
      if (lifecycle.signal.aborted) return
      const nextInventory = JSON.stringify(stableValue(listed.data.map(provider => ({
        id: provider.id, package: provider.package, settings: provider.settings, headers: provider.headers, integrationID: provider.integrationID,
      })).sort((a, b) => a.id.localeCompare(b.id))))
      const inventoryChanged = providerInventory !== nextInventory
      providerInventory = nextInventory
      const nextCandidates = new Map<string, AutoCandidate>()
      for (const provider of listed.data) {
        const auto = autoEndpointFromProvider(provider, configured)
        if (auto) nextCandidates.set(auto.endpoint.id, { auto, fingerprint: fingerprint(provider as Provider.Info, auto) })
      }
      candidates = nextCandidates
      const force = forceReconcile
      forceReconcile = false
      let changed = false
      if (!explicitLoaded) {
        explicitLoaded = true
        for (const [id, source] of explicit) {
          try {
            const next = await readSource(ctx, source.endpoint, false, lifecycle.signal)
            if (sourceState(source) !== sourceState(next)) changed = true
            explicit.set(id, next)
          } catch (error) {
            if (lifecycle.signal.aborted) return
            console.warn(`custom-api: discovery failed for ${id}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      for (const [id, candidate] of nextCandidates) {
        if (!force && reconciled.get(id) === candidate.fingerprint) continue
        const previous = automatic.get(id)
        try {
          const result = await readSource(ctx, candidate.auto.endpoint, false, lifecycle.signal, await resolveAutoCredential(ctx, candidate.auto))
          const next = { ...result, auto: candidate.auto }
          if (!previous || sourceState(previous) !== sourceState(next)) changed = true
          automatic.set(id, next)
        } catch (error) {
          if (lifecycle.signal.aborted) return
          console.warn(`custom-api: discovery failed for ${id}: ${error instanceof Error ? error.message : String(error)}`)
          const next = { endpoint: candidate.auto.endpoint, models: previous?.models ?? [], stale: true, auto: candidate.auto }
          if (!previous || sourceState(previous) !== sourceState(next)) changed = true
          automatic.set(id, next)
        }
      }
      for (const id of automatic.keys()) if (!nextCandidates.has(id)) {
        automatic.delete(id)
        changed = true
      }
      reconciled = new Map([...nextCandidates].map(([id, item]) => [id, item.fingerprint]))
      if (changed || inventoryChanged) await registerAtTail()
    }

    const scheduleReconcile = (force = false) => {
      if (lifecycle.signal.aborted) return
      forceReconcile ||= force
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        queue = queue.then(reconcile).catch(error => {
          if (!lifecycle.signal.aborted) console.warn(`custom-api: reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      })
    }

    const refresh = async (only?: string, signal?: AbortSignal) => {
      const selected = sources().filter(source => !only || source.endpoint.id === only)
      if (only && selected.length === 0) throw new Error(`Unknown endpoint: ${only}`)
      await Promise.all(selected.map(async source => {
        const credential = source.auto ? await resolveAutoCredential(ctx, source.auto) : undefined
        const next = await readSource(ctx, source.endpoint, true, signal, credential)
        source.models = next.models
        source.stale = next.stale
      }))
      await registerAtTail()
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

    const eventTask = (async () => {
      for await (const event of ctx.event.subscribe({ types: ["provider.updated", "integration.updated", "credential.updated", "credential.switched"], signal: lifecycle.signal })) {
        scheduleReconcile(event.type !== "provider.updated")
      }
    })().catch(error => { if (!lifecycle.signal.aborted) console.warn(`custom-api: event subscription failed: ${error instanceof Error ? error.message : String(error)}`) })

    // Hydrate providers already present in the core registry before setup returns so
    // sessions cannot select a discovered model during an empty startup window.
    forceReconcile = true
    await reconcile()

    const timers = [...explicit.values()].flatMap(source => source.endpoint.refreshIntervalMs && source.endpoint.refreshIntervalMs > 0 ? [setInterval(() => {
      const controller = new AbortController(); controllers.add(controller)
      void refresh(source.endpoint.id, controller.signal).catch(console.error).finally(() => controllers.delete(controller))
    }, source.endpoint.refreshIntervalMs)] : [])

    return async () => {
      timers.forEach(clearInterval)
      lifecycle.abort()
      controllers.forEach(controller => controller.abort())
      await Promise.all([providerRegistration.dispose(), modelRegistration.dispose(), toolRegistration.dispose(), commandRegistration.dispose(), eventTask, queue])
    }
  },
})
