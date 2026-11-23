import type { Storage } from "./cache.js"

/** What the public models.dev catalog knows about a model, reduced to the fields this plugin fills in. */
export interface KnownModel { context: number; output: number; tools: boolean; reasoning: boolean; input: string[] }
export type KnownIndex = Record<string, KnownModel>

export const MODELS_DEV_URL = "https://models.dev/api.json"
const KEY = "modelsdev/v1"
const TTL = 86_400_000

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0

/** Last path segment, lower-cased: the part of a gateway model ID that names the model itself. */
export const modelTail = (id: string) => (id.split("/").at(-1) ?? id).toLowerCase().replace(/^models\//, "").replace(/[_ ]/g, "-")

/** The tail as written, then without a routing tag (`:free`, `:batch`) or a `-free` / `-latest` marker. */
export function tailKeys(id: string): string[] {
  const tail = modelTail(id)
  const bare = tail.replace(/:[a-z0-9.-]+$/, "").replace(/-(?:free|latest)$/, "")
  return bare && bare !== tail ? [tail, bare] : [tail]
}

/** Most common value; a tie goes to the smaller one so a guess never overstates a limit. */
function majority(values: number[]): number | undefined {
  const counts = new Map<number, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: number | undefined
  for (const [value, count] of counts) {
    const top = best === undefined ? -1 : counts.get(best)!
    if (count > top || (count === top && value < best!)) best = value
  }
  return best
}

/** Collapses the catalog (provider -> models) into one consensus record per model name. */
export function buildIndex(api: unknown): KnownIndex {
  if (!object(api)) return {}
  const groups = new Map<string, { context: number; output: number; tools: boolean; reasoning: boolean; input: string[] }[]>()
  for (const provider of Object.values(api)) {
    if (!object(provider) || !object(provider.models)) continue
    for (const [id, model] of Object.entries(provider.models)) {
      if (!object(model) || !object(model.limit) || !positive(model.limit.context)) continue
      const input = object(model.modalities) && Array.isArray(model.modalities.input) ? model.modalities.input.filter((item): item is string => typeof item === "string") : []
      const entry = {
        context: model.limit.context,
        output: positive(model.limit.output) ? Math.min(model.limit.output, model.limit.context) : 0,
        tools: model.tool_call === true,
        reasoning: model.reasoning === true,
        input: input.length ? input : ["text"],
      }
      const key = modelTail(id)
      const group = groups.get(key)
      if (group) group.push(entry); else groups.set(key, [entry])
    }
  }
  const index: KnownIndex = {}
  for (const [key, group] of groups) {
    const context = majority(group.map(item => item.context))!
    const agreeing = group.filter(item => item.context === context)
    const output = majority(agreeing.map(item => item.output).filter(value => value > 0)) ?? Math.min(4096, context)
    const most = (pick: (item: (typeof group)[number]) => boolean) => group.filter(pick).length * 2 > group.length
    index[key] = { context, output, tools: most(item => item.tools), reasoning: most(item => item.reasoning), input: agreeing[0]!.input }
  }
  return index
}

/** `exact` only accepts the model name as written; otherwise the name without its tag or marker is tried too. */
export function lookupKnown(index: KnownIndex, id: string, exact = false): KnownModel | undefined {
  for (const key of exact ? [modelTail(id)] : tailKeys(id)) if (Object.hasOwn(index, key)) return index[key]
  return undefined
}

function validIndex(value: unknown): value is { savedAt: number; index: KnownIndex } {
  return object(value) && typeof value.savedAt === "number" && object(value.index)
}

/** Loads the catalog once a day; a failed download falls back to the last stored copy, then to nothing. */
export async function loadKnownModels(storage: Storage, url = MODELS_DEV_URL, signal?: AbortSignal, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<{ index: KnownIndex; error?: string }> {
  let cached: { savedAt: number; index: KnownIndex } | undefined
  try {
    const stored = await storage.get(KEY)
    if (validIndex(stored)) cached = stored
  } catch { /* storage is optional */ }
  if (cached && now - cached.savedAt < TTL) return { index: cached.index }
  try {
    const timeout = AbortSignal.timeout(30_000)
    const response = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "opencode-custom-api" }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`)
    const index = buildIndex(await response.json())
    if (Object.keys(index).length === 0) throw new Error("models.dev returned no usable models")
    try { await storage.set(KEY, { savedAt: now, index }) } catch { /* keep going without the cache */ }
    return { index }
  } catch (error) {
    return { index: cached?.index ?? {}, error: error instanceof Error ? error.message : String(error) }
  }
}
