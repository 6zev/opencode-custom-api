import type { CacheEntry, DiscoveredModel } from "./types.js"

export interface Storage { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> }
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0
const provenanceValues = new Set(["endpoint", "catalog", "heuristic", "default"])
function validModel(value: unknown): value is DiscoveredModel {
  if (!object(value)) return false
  if (typeof value.id !== "string" || !value.id || typeof value.name !== "string") return false
  if (!positiveInteger(value.context) || !positiveInteger(value.output) || value.output > value.context) return false
  if (!Array.isArray(value.input) || !value.input.every(item => typeof item === "string")) return false
  if (typeof value.tools !== "boolean" || typeof value.reasoning !== "boolean") return false
  if (value.type !== undefined && typeof value.type !== "string") return false
  return object(value.provenance) && Object.values(value.provenance).every(item => typeof item === "string" && provenanceValues.has(item))
}
export function validCache(value: unknown): value is CacheEntry {
  if (!object(value)) return false
  return value.version === 1 && typeof value.savedAt === "number" && Number.isFinite(value.savedAt) && value.savedAt >= 0 && Array.isArray(value.models) && value.models.every(validModel)
}
export async function loadWithCache(storage: Storage, key: string, ttl: number, loader: () => Promise<DiscoveredModel[]>, now = Date.now()): Promise<{ models: DiscoveredModel[]; stale: boolean }> {
  const cachedValue = await storage.get(key)
  const cached = validCache(cachedValue) ? cachedValue : undefined
  if (cached && now - cached.savedAt < ttl) return { models: cached.models, stale: false }
  try {
    const models = await loader()
    await storage.set(key, { version: 1, savedAt: now, models } satisfies CacheEntry)
    return { models, stale: false }
  } catch (error) {
    if (cached) return { models: cached.models, stale: true }
    throw error
  }
}
