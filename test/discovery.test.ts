import { afterEach, describe, expect, it, vi } from "vitest"
import { discover, discoveryURLs, parseModels, resolveHeaders } from "../src/discovery.js"
import type { EndpointOptions } from "../src/types.js"

const endpoint = (extra: Partial<EndpointOptions> = {}): EndpointOptions => ({ id: "local", baseURL: "http://localhost:9000", protocol: "openai-compatible", ...extra })
afterEach(() => { delete process.env.TEST_KEY })

describe("discovery", () => {
  it("uses /models directly for v1 and falls back otherwise", async () => {
    expect(discoveryURLs("http://x/v1/")).toEqual(["http://x/v1/models"])
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("no", { status: 404 }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "ok" }] }))
    expect(await discover(endpoint(), undefined, fetcher)).toEqual([{ id: "ok" }])
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(["http://localhost:9000/v1/models", "http://localhost:9000/models"])
  })

  it("parses supported response shapes", () => {
    expect(parseModels([{ id: "a" }])).toHaveLength(1)
    expect(parseModels({ data: [{ id: "a" }] })).toHaveLength(1)
    expect(parseModels({ models: [{ id: "a" }] })).toHaveLength(1)
    expect(parseModels({ models: { a: { name: "A" } } })).toEqual([{ id: "a", name: "A" }])
  })

  it("sets protocol auth headers without persisting credentials", () => {
    process.env.TEST_KEY = "secret"
    expect(resolveHeaders(endpoint({ apiKey: { env: "TEST_KEY" } })).Authorization).toBe("Bearer secret")
    const anthropic = resolveHeaders(endpoint({ protocol: "anthropic-compatible", apiKey: { env: "TEST_KEY" } }))
    expect(anthropic["x-api-key"]).toBe("secret")
    expect(anthropic["anthropic-version"]).toBe("2023-06-01")
  })

  it("honors cancellation and timeout", async () => {
    const hanging = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))))
    await expect(discover(endpoint({ timeoutMs: 5, baseURL: "http://x/v1" }), undefined, hanging)).rejects.toThrow("timed out")
    const controller = new AbortController()
    const promise = discover(endpoint({ timeoutMs: 1000, baseURL: "http://x/v1" }), controller.signal, hanging)
    controller.abort(new Error("cancelled"))
    await expect(promise).rejects.toThrow("cancelled")
  })
})
