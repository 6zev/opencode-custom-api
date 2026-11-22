import type { EndpointOptions, ModelMetadata } from "./types.js"

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

export function discoveryURLs(baseURL: string): string[] {
  const base = baseURL.replace(/\/+$/, "")
  return /\/v1$/i.test(base) ? [`${base}/models`] : [`${base}/v1/models`, `${base}/models`]
}

export function resolveHeaders(endpoint: EndpointOptions, credential?: string): Record<string, string> {
  const result: Record<string, string> = { Accept: "application/json", "User-Agent": "opencode-custom-api" }
  for (const [key, source] of Object.entries(endpoint.headers ?? {})) {
    const header = typeof source === "string" ? source : process.env[source.env]
    if (header !== undefined) result[key] = header
  }
  const value = credential ?? (endpoint.apiKey ? process.env[endpoint.apiKey.env] : undefined)
  if (value) {
    if (endpoint.protocol === "anthropic-compatible") {
      result["x-api-key"] = value
      result["anthropic-version"] = "2023-06-01"
    } else result.Authorization = `Bearer ${value}`
  }
  return result
}

export function parseModels(payload: unknown): ModelMetadata[] {
  let value: unknown = payload
  if (object(payload)) value = payload.data ?? payload.models
  if (Array.isArray(value)) return value.filter(object) as ModelMetadata[]
  if (object(value)) return Object.entries(value).flatMap(([id, item]) => object(item) ? [{ id, ...item } as ModelMetadata] : [])
  throw new Error("Unsupported model-list response shape")
}

function combinedSignal(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error(`Discovery timed out after ${timeoutMs}ms`)), timeoutMs)
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener("abort", abort, { once: true })
  return { signal: controller.signal, cleanup: () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort) } }
}

export async function discover(endpoint: EndpointOptions, signal?: AbortSignal, fetcher: typeof fetch = fetch, credential?: string): Promise<ModelMetadata[]> {
  const errors: string[] = []
  for (const url of discoveryURLs(endpoint.baseURL)) {
    const linked = combinedSignal(endpoint.timeoutMs ?? 10_000, signal)
    try {
      const response = await fetcher(url, { headers: resolveHeaders(endpoint, credential), signal: linked.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return parseModels(await response.json())
    } catch (error) {
      if (signal?.aborted) throw error
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    } finally { linked.cleanup() }
  }
  throw new Error(`Model discovery failed (${errors.join("; ")})`)
}
