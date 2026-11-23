import { Model, Plugin, Provider } from "@opencode/plugin"
import type { Plugin as PluginTypes } from "@opencode/plugin"
import { discover } from "./discovery.js"
import { loadWithCache } from "./cache.js"
import { normalizeModel } from "./normalize.js"
import { autoEndpointFromProvider, credentialSecret, keepRoute, looksBuiltin, mergeDiscoveredModels, type AutoEndpoint } from "./autodiscovery.js"
import { compilePatterns, filterModels } from "./filter.js"
import { loadKnownModels, lookupKnown, modelTail, tailKeys, type KnownIndex, type KnownModel } from "./modelsdev.js"
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

/**
 * Resolves an API model against OpenCode's already-normalized host catalog.
 * Several catalog providers often carry the same model; the one named in the gateway ID wins,
 * otherwise the most common context size (the smaller one on a tie).
 * `asWritten` refuses to fall back to the name without its `:tag` / `-free` / `-latest` marker.
 */
export function matchHostModel(id: string, records: readonly ProviderRecord[], asWritten = false): Model.Info | undefined {
  const candidates = records.flatMap(record => [...record.models.values()].map(model => ({ model, provider: record.provider })))
  const segments = new Set(id.toLowerCase().split("/").slice(0, -1))
  const pick = (items: typeof candidates) => {
    if (items.length <= 1) return items[0]?.model
    const named = items.filter(({ model, provider }) => segments.has(provider.id.toLowerCase()) || segments.has(String(model.canonical ?? "").toLowerCase()))
    if (named.length === 1) return named[0]!.model
    const counts = new Map<number, number>()
    const size = (model: Model.Info) => model.limit?.context ?? 0
    for (const { model } of items) counts.set(size(model), (counts.get(size(model)) ?? 0) + 1)
    const best = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0]
    return items.find(({ model }) => size(model) === best)!.model
  }
  const exact = candidates.filter(({ model }) => model.id === id || model.modelID === id)
  if (exact.length) return pick(exact)
  const suffix = candidates.filter(({ model, provider }) => {
    const canonical = model.canonical ?? provider.id
    return id.endsWith(`/${canonical}/${model.modelID}`) || id === `${canonical}/${model.modelID}`
  })
  if (suffix.length) return pick(suffix)
  for (const key of asWritten ? [modelTail(id)] : tailKeys(id)) {
    const matches = candidates.filter(({ model }) => modelTail(model.modelID) === key)
    if (matches.length) return pick(matches)
  }
  return undefined
}

const validDuration = (value: unknown, allowZero: boolean) => typeof value === "number" && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0)

export function parsePluginOptions(value: unknown): PluginOptions {
  if (value === undefined || value === null) return { endpoints: [] }
  if (typeof value !== "object") throw new Error("custom-api: options must be an object")
  const auto = parseAutoOptions((value as { auto?: unknown }).auto)
  const modelsDev = (value as { modelsDev?: unknown }).modelsDev
  if (modelsDev !== undefined && typeof modelsDev !== "boolean" && !(typeof modelsDev === "string" && /^https?:\/\//i.test(modelsDev))) throw new Error("custom-api: modelsDev must be a boolean or an HTTP(S) URL")
  const withAuto = (endpoints: EndpointOptions[]): PluginOptions => ({ endpoints, ...(auto ? { auto } : {}), ...(modelsDev !== undefined && modelsDev !== true ? { modelsDev } : {}) })
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
  if (auto.builtin !== undefined && typeof auto.builtin !== "boolean") throw new Error("custom-api: auto.builtin must be a boolean")
  if (auto.providers !== undefined && (!Array.isArray(auto.providers) || !auto.providers.every(item => typeof item === "string"))) throw new Error("custom-api: auto.providers must be an array of provider IDs")
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

function toModel(providerID: Provider.ID, value: DiscoveredModel, catalog?: Model.Info, known?: KnownModel): Model.Info {
  const hostCapabilities = catalog?.capabilities
  const hostLimit = catalog?.limit
  const unset = (field: string) => value.provenance[field] === "default"
  const context = unset("context") ? hostLimit?.context || known?.context || value.context : value.context
  const output = unset("output") ? hostLimit?.output || known?.output || value.output : value.output
  const tools = unset("tools") ? hostCapabilities?.tools ?? known?.tools ?? value.tools : value.tools
  const input = unset("input") ? [...(hostCapabilities?.input ?? known?.input ?? value.input)] : value.input
  const reasoning = unset("reasoning") ? (catalog ? catalog.variants.length > 0 : known?.reasoning ?? value.reasoning) : value.reasoning
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
    /** Public models.dev catalog, used only for fields neither the gateway nor OpenCode's own catalog supplies. */
    let known: KnownIndex = {}
    let knownError: string | undefined
    /** First-sight classification, taken before this plugin has touched the provider. */
    const kinds = new Map<string, "builtin" | "custom">()
    /** Explicit endpoints whose ID already belonged to a configured provider. */
    const preexisting = new Map<string, boolean>()
    const skipped = new Map<string, string>()
    const health = new Map<string, { refreshedAt?: number; error?: string }>()
    const timers = new Map<string, { interval: number; timer: ReturnType<typeof setInterval> }>()
    const succeeded = (id: string) => health.set(id, { refreshedAt: Date.now() })
    const failed = (id: string, error: unknown) => health.set(id, { ...health.get(id), error: error instanceof Error ? error.message : String(error) })

    const applyProviders = (editor: Parameters<Parameters<typeof ctx.provider.transform>[0]>[0]) => {
      const owned = new Set(sources().map(source => source.endpoint.id))
      for (const record of editor.list()) if (!kinds.has(record.provider.id)) kinds.set(record.provider.id, looksBuiltin(record) ? "builtin" : "custom")
      hostRecords.clear()
      for (const record of editor.list()) if (!owned.has(record.provider.id)) hostRecords.set(record.provider.id, record)
      for (const source of sources()) {
        const endpoint = source.endpoint
        const id = Provider.ID.make(endpoint.id)
        const catalog = [...hostRecords.values()]
        // A model name as written always beats a name with its marker stripped, whichever catalog it is in:
        // "x-free" often has smaller limits than "x", so the base model is only a last resort.
        const discovered = source.models.map(model => {
          const host = matchHostModel(model.id, catalog, true)
          const named = host ? undefined : lookupKnown(known, model.id, true)
          return toModel(id, model, host ?? (named ? undefined : matchHostModel(model.id, catalog)), named ?? lookupKnown(known, model.id))
        })
        if (source.auto) {
          // Pruning only happens on a live, non-empty inventory so an outage never empties a provider.
          // A built-in provider that was opted in keeps its catalog models; only its additions come from discovery.
          const prune = endpoint.pruneMissing === true && kinds.get(endpoint.id) !== "builtin" && !source.stale && discovered.length > 0
          const existing = editor.get(endpoint.id)?.models ?? new Map<string, Model.Info>()
          editor.models.set(endpoint.id, prune ? discovered.map(model => keepRoute(model, existing.get(model.id))) : mergeDiscoveredModels(discovered, existing))
          continue
        }
        if (!preexisting.has(endpoint.id)) preexisting.set(endpoint.id, editor.get(endpoint.id) !== undefined)
        if (preexisting.get(endpoint.id)) {
          // The ID belongs to a provider the user already configured: add models, keep its runtime and settings.
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
      const eligible = listed.data.flatMap(provider => {
        const auto = autoEndpointFromProvider(provider, configured, config.auto)
        return auto ? [{ provider, auto }] : []
      })
      // A provider first seen here has not been classified yet; one registration pass does that.
      if (eligible.some(({ provider }) => !kinds.has(provider.id))) await registerAtTail()
      if (lifecycle.signal.aborted) return
      skipped.clear()
      const allowed = config.auto?.providers
      for (const { provider, auto } of eligible) {
        const id = auto.endpoint.id
        const forced = (provider.settings?.modelsDiscovery as { enabled?: unknown } | undefined)?.enabled === true
        const listedExplicitly = allowed?.includes(id) === true
        if (!forced && allowed && !listedExplicitly) { skipped.set(id, "not listed in auto.providers"); continue }
        if (!forced && !listedExplicitly && config.auto?.builtin !== true && kinds.get(id) !== "custom") {
          skipped.set(id, kinds.get(id) === "builtin" ? "built-in provider" : "not classified yet")
          continue
        }
        nextCandidates.set(id, { auto, fingerprint: fingerprint(provider as Provider.Info, auto) })
      }
      const present = new Set(listed.data.map(provider => provider.id))
      for (const id of kinds.keys()) if (!present.has(id) && !explicit.has(id)) kinds.delete(id)
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

    const status = () => [...sources().map(source => {
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
        // Models with no context size from the gateway that the models.dev catalog recognises.
        knownByModelsDev: source.models.filter(model => model.provenance.context === "default" && lookupKnown(known, model.id)).length,
      }
    }), ...[...skipped].map(([endpoint, reason]) => ({ endpoint, mode: "skipped", reason })),
    ...(config.modelsDev === false ? [] : [{ endpoint: "models.dev", mode: "metadata", models: Object.keys(known).length, ...(knownError ? { error: knownError } : {}) }])]

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
    if (config.modelsDev !== false) {
      const loading = loadKnownModels({ get: key => ctx.storage.get(key), set: (key, value) => ctx.storage.set(key, value as never) }, typeof config.modelsDev === "string" ? config.modelsDev : undefined, lifecycle.signal)
        .then(result => { known = result.index; knownError = result.error; return true })
        .catch(error => { knownError = error instanceof Error ? error.message : String(error); return true })
      // Wait briefly so the first model list already carries the catalog facts; a slow download fills them in afterwards.
      let waiting: ReturnType<typeof setTimeout> | undefined
      const ready = await Promise.race([loading, new Promise<false>(resolve => { waiting = setTimeout(() => resolve(false), 8_000) })])
      clearTimeout(waiting)
      if (!ready) void loading.then(() => { if (!lifecycle.signal.aborted && Object.keys(known).length) queue = queue.then(registerAtTail).catch(() => {}) })
    }
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
