import { describe, expect, it, vi } from "vitest"
import { loadWithCache, type Storage } from "../src/cache.js"
import type { CacheEntry, DiscoveredModel } from "../src/types.js"

const model = { id: "a", name: "A", context: 1, output: 1, input: ["text"], tools: false, reasoning: false, provenance: {} } satisfies DiscoveredModel
class Memory implements Storage {
  value: CacheEntry | undefined
  async get() { return this.value }
  async set(_key: string, value: unknown) { this.value = value as CacheEntry }
}

describe("cache", () => {
  it("uses fresh cache", async () => {
    const storage = new Memory(); storage.value = { version: 1, savedAt: 90, models: [model] }
    const loader = vi.fn(async () => [])
    expect(await loadWithCache(storage, "key", 20, loader, 100)).toEqual({ models: [model], stale: false })
    expect(loader).not.toHaveBeenCalled()
  })
  it("stores success and falls back to stale on failure", async () => {
    const storage = new Memory()
    await loadWithCache(storage, "key", 10, async () => [model], 10)
    expect(storage.value?.version).toBe(1)
    expect(await loadWithCache(storage, "key", 10, async () => { throw new Error("down") }, 100)).toEqual({ models: [model], stale: true })
  })
  it("rejects failure without valid cache", async () => {
    await expect(loadWithCache(new Memory(), "key", 10, async () => { throw new Error("down") })).rejects.toThrow("down")
  })
  it("ignores malformed versioned model data", async () => {
    const storage = new Memory()
    storage.value = { version: 1, savedAt: 100, models: [{ ...model, tools: "yes" }] } as unknown as CacheEntry
    const loader = vi.fn(async () => [model])
    expect(await loadWithCache(storage, "key", 1_000, loader, 101)).toEqual({ models: [model], stale: false })
    expect(loader).toHaveBeenCalledOnce()
  })
})
