/** Compiles model ID patterns. Matching is case-insensitive; an invalid pattern throws with `label` for context. */
export function compilePatterns(patterns: readonly string[] | undefined, label: string): RegExp[] {
  return (patterns ?? []).map(pattern => {
    try {
      return new RegExp(pattern, "i")
    } catch (error) {
      throw new Error(`${label}: invalid pattern ${JSON.stringify(pattern)} (${error instanceof Error ? error.message : String(error)})`)
    }
  })
}

/** Returns the patterns when every entry is a compilable string, otherwise undefined. */
export function validPatterns(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) return undefined
  try {
    compilePatterns(value, "pattern")
    return value
  } catch {
    return undefined
  }
}

/** Keeps IDs matching any `include` pattern (when given) and none of the `exclude` patterns. */
export function filterModels<T extends { id: string }>(models: readonly T[], include?: readonly string[], exclude?: readonly string[]): T[] {
  if (!include?.length && !exclude?.length) return [...models]
  const allow = compilePatterns(include, "include")
  const deny = compilePatterns(exclude, "exclude")
  return models.filter(model => (allow.length === 0 || allow.some(pattern => pattern.test(model.id))) && !deny.some(pattern => pattern.test(model.id)))
}
