import { Model, Plugin, Provider } from "@opencode/plugin"
import type { Plugin as PluginTypes } from "@opencode/plugin"
import { discover } from "./discovery.js"
import { loadWithCache } from "./cache.js"
import { normalizeModel } from "./normalize.js"
import { autoEndpointFromProvider, credentialSecret, mergeDiscoveredModels, type AutoEndpoint } from "./autodiscovery.js"
import { compilePatterns, filterModels } from "./filter.js"
import type { AutoOptions, DiscoveredModel, EndpointOptions, PluginOptions } from "./types.js"

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

type ProviderRecord = { provider: Provider.Info; models: ReadonlyMap<string, Model.Info> }

const normalizedTail = (id: string) => (id.split("/").at(-1) ?? id).toLowerCase().replace(/^models\//, "").replace(/[_ ]/g, "-")

/** Conservatively resolves an API model against OpenCode's already-normalized host catalog. */
export function matchHostModel(id: string, records: readonly ProviderRecord[]): Model.Info | undefined {
  const candidates = records.flatMap(record => [...record.models.values()].map(model => ({ model, provider: record.provider })))
  const unique = (items: typeof candidates) => items.length === 1 ? items[0]?.model : undefined
  const exact = candidates.filter(({ model }) => model.id === id || model.modelID === id)
  if (exact.length) return unique(exact)
  const suffix = candidates.filter(({ model, provider }) => {
    const canonical = model.canonical ?? provider.id
    return id.endsWith(`/${canonical}/${model.modelID}`) || id === `${canonical}/${model.modelID}`
  })
  if (suffix.length) return unique(suffix)
  const normalized = normalizedTail(id)
  return unique(candidates.filter(({ model }) => normalizedTail(model.modelID) === normalized))
}

const validDuration = (value: unknown, allowZero: boolean) => typeof value === "number" && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)

export function parsePluginOptions(value: unknown): PluginOptions {
  if (value === undefined || value === null) return { endpoints: [] }
  if (typeof value !== "object") throw new Error("custom-api: options must be an object")
  const auto = parseAutoOptions((value as { auto?: unknown }).auto)
  const withAuto = (endpoints: EndpointOptions[]): PluginOptions => auto ? { endpoints, auto } : { endpoints }
  if (!("endpoints" in value)) return withAuto([])
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
    if (endpoint.endpoint !== undefined && (typeof endpoint.endpoint !== "string" || !(endpoint.endpoint.startsWith("/") || /^https?:\/\//i.test(endpoint.endpoint)))) throw new Error(`custom-api: ${endpoint.id}.endpoint must be an absolute URL or begin with "/"`)
    parsePatterns(endpoint.include, `custom-api: ${endpoint.id}.include`)
    parsePatterns(endpoint.exclude, `custom-api: ${endpoint.id}.exclude`)
  }
  return withAuto(endpoints)
}

function parsePatterns(value: unknown, label: string): void {
  if (value === undefined) return
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) throw new Error(`${label} must be an array of regular expression strings`)
  compilePatterns(value, label)
}

function parseAutoOptions(value: unknown): AutoOptions | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("custom-api: options.auto must be an object")
  const auto = value as AutoOptions
  if (auto.enabled !== undefined && typeof auto.enabled !== "boolean") throw new Error("custom-api: auto.enabled must be a boolean")
  if (auto.pruneMissing !== undefined && typeof auto.pruneMissing !== "boolean") throw new Error("custom-api: auto.pruneMissing must be a boolean")
  if (auto.timeoutMs !== undefined && !validDuration(auto.timeoutMs, false)) throw new Error("custom-api: auto.timeoutMs must be finite and positive")
  if (auto.cacheTtlMs !== undefined && !validDuration(auto.cacheTtlMs, true)) throw new Error("custom-api: auto.cacheTtlMs must be finite and nonnegative")
  if (auto.refreshIntervalMs !== undefined && !validDuration(auto.refreshIntervalMs, true)) throw new Error("custom-api: auto.refreshIntervalMs must be finite and nonnegative")
  parsePatterns(auto.include, "custom-api: auto.include")
  parsePatterns(auto.exclude, "custom-api: auto.exclude")
  return auto
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

function toModel(providerID: Provider.ID, value: DiscoveredModel, catalog?: Model.Info): Model.Info {
  const hostCapabilities = catalog?.capabilities
  const hostLimit = catalog?.limit
  const context = value.provenance.context === "default" && hostLimit ? hostLimit.context : value.context
  const output = value.provenance.output === "default" && hostLimit ? hostLimit.output : value.output
  const tools = value.provenance.tools === "default" && hostCapabilities ? hostCapabilities.tools : value.tools
  const input = value.provenance.input === "default" && hostCapabilities ? [...hostCapabilities.input] : value.input
  const reasoning = value.provenance.reasoning === "default" && catalog ? catalog.variants.length > 0 : value.reasoning
  const variants = reasoning ? catalog?.variants.length ? catalog.variants.map(variant => ({ ...variant })) : reasoningVariants(value.id) : []
  return {
    ...Model.Info.default(providerID, Model.ID.make(value.id)),
    ...(catalog?.family ? { family: catalog.family } : {}),
    name: value.provenance.name === "default" && catalog ? catalog.name : value.name,
    type: value.type ?? catalog?.type,
    limit: { ...catalog?.limit, context, output: Math.min(output, context) },
    capabilities: { ...hostCapabilities, tools, input, output: hostCapabilities?.output ?? ["text"] },
    variants,
  }
}

function reasoningVariants(modelID: string): Model.Info["variants"] {
  const efforts = /(?:^|\/)kimi-k3(?:[.-]|$)/i.test(modelID) ? ["low", "high", "max"] : ["low", "medium", "high", "xhigh"]
  return efforts.map(id => ({ id: Model.VariantID.make(id), settings: { reasoningEffort: id } }))
}

async function readSource(ctx: Context, endpoint: EndpointOptions, force = false, signal?: AbortSignal, credential?: string): Promise<Source> {
  const load = async () => (await discover(endpoint, signal, fetch, credential)).map(raw => normalizeModel(raw, endpoint.catalog)).filter((item): item is DiscoveredModel => item !== undefined)
  const cache = await loadWithCache(
    { get: key => ctx.storage.get(key), set: (key, value) => ctx.storage.set(key, value as never) },
    `inventory/v3/${endpoint.id}`,
    force ? 0 : endpoint.cacheTtlMs ?? 300_000,
    load,
  )
  // Filters run after the cache so changing them takes effect without another request.
  return { endpoint, models: filterModels(cache.models, endpoint.include, endpoint.exclude), stale: cache.stale }
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
    const hostRecords = new Map<string, ProviderRecord>()
    const health = new Map<string, { refreshedAt?: number; error?: string }>()
    const timers = new Map<string, { interval: number; timer: ReturnType<typeof setInterval> }>()
    const succeeded = (id: string) => health.set(id, { refreshedAt: Date.now() })
    const failed = (id: string, error: unknown) => health.set(id, { ...health.get(id), error: error instanceof Error ? error.message : String(error) })

    const applyProviders = (editor: Parameters<Parameters<typeof ctx.provider.transform>[0]>[0]) => {
      const owned = new Set(sources().map(source => source.endpoint.id))
      hostRecords.clear()
      for (const record of editor.list()) if (!owned.has(record.provider.id)) hostRecords.set(record.provider.id, record)
      for (const source of sources()) {
        const endpoint = source.endpoint
        const id = Provider.ID.make(endpoint.id)
        const catalog = [...hostRecords.values()]
        const discovered = source.models.map(model => toModel(id, model, matchHostModel(model.id, catalog)))
        if (source.auto) {
          // Pruning only happens on a live, non-empty inventory so an outage never empties a provider.
          const prune = endpoint.pruneMissing === true && !source.stale && discovered.length > 0
          editor.models.set(endpoint.id, prune ? discovered : mergeDiscoveredModels(discovered, editor.get(endpoint.id)?.models ?? new Map()))
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
    let providerRegistration = await ctx.provider.transform(applyProviders)

    const registerAtTail = async () => {
      if (lifecycle.signal.aborted) return
      const nextProviderRegistration = await ctx.provider.transform(applyProviders)
      if (lifecycle.signal.aborted) return nextProviderRegistration.dispose()
      const previousProviderRegistration = providerRegistration
      providerRegistration = nextProviderRegistration
      await previousProviderRegistration.dispose()
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
        const auto = autoEndpointFromProvider(provider, configured, config.auto)
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
            succeeded(id)
          } catch (error) {
            if (lifecycle.signal.aborted) return
            failed(id, error)
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
          succeeded(id)
        } catch (error) {
          if (lifecycle.signal.aborted) return
          failed(id, error)
          console.warn(`custom-api: discovery failed for ${id}: ${error instanceof Error ? error.message : String(error)}`)
          const next = { endpoint: candidate.auto.endpoint, models: previous?.models ?? [], stale: true, auto: candidate.auto }
          if (!previous || sourceState(previous) !== sourceState(next)) changed = true
          automatic.set(id, next)
        }
      }
      for (const id of automatic.keys()) if (!nextCandidates.has(id)) {
        automatic.delete(id)
        health.delete(id)
        changed = true
      }
      reconciled = new Map([...nextCandidates].map(([id, item]) => [id, item.fingerprint]))
      if (changed || inventoryChanged) await registerAtTail()
      syncTimers()
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

    /** `quiet` is the background path: failures keep the previous inventory and nothing is re-registered unless it changed. */
    const refresh = async (only?: string, signal?: AbortSignal, quiet = false) => {
      const selected = sources().filter(source => !only || source.endpoint.id === only)
      if (only && selected.length === 0) {
        if (quiet) return []
        throw new Error(`Unknown endpoint: ${only}`)
      }
      let changed = false
      await Promise.all(selected.map(async source => {
        const before = sourceState(source)
        try {
          const credential = source.auto ? await resolveAutoCredential(ctx, source.auto) : undefined
          const next = await readSource(ctx, source.endpoint, true, signal, credential)
          source.models = next.models
          source.stale = next.stale
          if (next.stale) failed(source.endpoint.id, "refresh failed; serving the last successful inventory")
          else succeeded(source.endpoint.id)
        } catch (error) {
          failed(source.endpoint.id, error)
          if (!quiet) throw error
          if (!signal?.aborted && !lifecycle.signal.aborted) console.warn(`custom-api: refresh failed for ${source.endpoint.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (sourceState(source) !== before) changed = true
      }))
      if (changed || !quiet) await registerAtTail()
      return selected.map(source => ({ endpoint: source.endpoint.id, models: source.models.length, stale: source.stale }))
    }

    /** Keeps one background timer per source whose refresh interval is positive, for explicit and auto-detected providers alike. */
    function syncTimers() {
      if (lifecycle.signal.aborted) return
      const wanted = new Map(sources().flatMap(source => source.endpoint.refreshIntervalMs && source.endpoint.refreshIntervalMs > 0 ? [[source.endpoint.id, source.endpoint.refreshIntervalMs] as const] : []))
      for (const [id, entry] of timers) if (wanted.get(id) !== entry.interval) {
        clearInterval(entry.timer)
        timers.delete(id)
      }
      for (const [id, interval] of wanted) {
        if (timers.has(id)) continue
        const timer = setInterval(() => {
          const controller = new AbortController(); controllers.add(controller)
          void refresh(id, controller.signal, true).catch(error => {
            if (!lifecycle.signal.aborted) console.warn(`custom-api: background refresh failed for ${id}: ${error instanceof Error ? error.message : String(error)}`)
          }).finally(() => controllers.delete(controller))
        }, interval)
        // A pending refresh must never keep the OpenCode process alive on shutdown.
        ;(timer as { unref?: () => void }).unref?.()
        timers.set(id, { interval, timer })
      }
    }

    const status = () => sources().map(source => {
      const provenance: Record<string, number> = {}
      for (const model of source.models) for (const field of ["context", "tools", "reasoning", "input"] as const) {
        const key = `${field}:${model.provenance[field] ?? "default"}`
        provenance[key] = (provenance[key] ?? 0) + 1
      }
      const state = health.get(source.endpoint.id)
      return {
        endpoint: source.endpoint.id,
        mode: source.auto ? "auto" : "explicit",
        protocol: source.endpoint.protocol,
        models: source.models.length,
        stale: source.stale,
        refreshIntervalMs: source.endpoint.refreshIntervalMs ?? 0,
        pruneMissing: source.endpoint.pruneMissing === true,
        ...(source.endpoint.include ? { include: source.endpoint.include } : {}),
        ...(source.endpoint.exclude ? { exclude: source.endpoint.exclude } : {}),
        ...(state?.refreshedAt ? { refreshedAt: new Date(state.refreshedAt).toISOString() } : {}),
        ...(state?.error ? { error: state.error } : {}),
        metadata: provenance,
      }
    })

    const toolRegistration = await ctx.tool.transform(editor => {
      editor.namespace({ name: "custom_api", description: "Custom API endpoint inventory management" })
      editor.add({
        name: "refresh",
        description: "Refresh custom endpoint model inventories. Optionally restrict to one endpoint ID.",
        input: { type: "object", properties: { endpoint: { type: "string" } }, additionalProperties: false },
        options: { namespace: "custom_api", codemode: false },
        execute: async (input, context) => ({ content: JSON.stringify(await refresh((input as { endpoint?: string }).endpoint, context.signal)) }),
      })
      editor.add({
        name: "status",
        description: "Report each custom endpoint: model count, last refresh, last error, filters, and where model metadata came from. Makes no network request.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "custom_api", codemode: false },
        execute: async () => ({ content: JSON.stringify(status()) }),
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

    return async () => {
      lifecycle.abort()
      for (const entry of timers.values()) clearInterval(entry.timer)
      timers.clear()
      controllers.forEach(controller => controller.abort())
      await Promise.all([providerRegistration.dispose(), toolRegistration.dispose(), commandRegistration.dispose(), eventTask, queue])
    }
  },
})
