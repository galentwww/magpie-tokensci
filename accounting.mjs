import { createHash } from "node:crypto"

export const buckets = ["input", "output", "cacheRead", "cacheWrite", "reasoning"]
export const zeroTokens = () => Object.fromEntries(buckets.map(k => [k, 0]))
export const tokenTotal = tokens => buckets.reduce((sum, k) => sum + (tokens[k] || 0), 0)

export function dayAt(time, timezone) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(time))
  const part = key => parts.find(p => p.type === key).value
  return `${part("year")}-${part("month")}-${part("day")}`
}

export function validateConfig(config) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.from) ||
      new Date(`${config.from}T00:00:00Z`).toISOString().slice(0, 10) !== config.from) {
    throw new Error("from must be a calendar date (YYYY-MM-DD)")
  }
  dayAt(Date.now(), config.timezone)
  for (const [name, values] of Object.entries({
    models: config.models, "local.clients": config.local?.clients,
    "local.providers": config.local?.providers, "gateway.agents": config.gateway?.agents,
  })) {
    if (!Array.isArray(values) || !values.length || values.some(v => typeof v !== "string" || !v)) {
      throw new Error(`${name} must be a nonempty array of strings`)
    }
  }
  const keys = config.gateway?.callerKeyIds
  if (!Array.isArray(keys) || keys.some(k => typeof k !== "string" || !k)) {
    throw new Error("gateway.callerKeyIds must be an array of key IDs")
  }
  if (!Number.isInteger(config.intervalMinutes) || config.intervalMinutes < 1) {
    throw new Error("intervalMinutes must be a positive integer")
  }
  if (!Array.isArray(config.gateway.logs) || !config.gateway.logs.length ||
      config.gateway.logs.some(p => typeof p !== "string" || !p)) {
    throw new Error("gateway.logs must list the usage.jsonl paths")
  }
  // One partition has one immutable source owner. Changing it requires a migration.
  return config
}

export function localOwned(row, date, config) {
  return date >= config.from && config.local.clients.includes(row.client) &&
    config.local.providers.includes(row.providerId) && config.models.includes(row.modelId)
}

export function gatewayEvent(row, config) {
  if (!config.models.includes(row.req) || !config.gateway.agents.includes(row.agent)) return null
  if (!config.gateway.allCallers && !config.gateway.callerKeyIds.includes(row.callerKeyId)) return null
  if (row.source || row.operation || row.rejected) return null
  if (!row.t || !Number.isFinite(Date.parse(row.t))) throw new Error("Matched ledger row has no valid timestamp")
  if (dayAt(row.t, config.timezone) < config.from) return null
  const usage = {}
  for (const [dest, src] of [["input_tokens", "in"], ["output_tokens", "out"],
    ["cache_read_input_tokens", "cache_read"], ["cache_creation_input_tokens", "cache_write"]]) {
    const value = row[src] ?? 0
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${src} in matched ledger row`)
    usage[dest] = value
  }
  if (!Object.values(usage).some(n => n > 0)) return null
  // Output already includes reasoning. Failed/aborted attempts with reported usage
  // still consumed tokens, so retain them; zero-usage failures are discarded above.
  const model = row.served && !row.served.startsWith("group/") ? row.served : row.model
  if (typeof model !== "string" || !model || model.startsWith("group/")) {
    throw new Error("Matched ledger row has no actual model")
  }
  if (row.cache_write_1h) {
    if (!Number.isSafeInteger(row.cache_write_1h) || row.cache_write_1h < 0 ||
        row.cache_write_1h > usage.cache_creation_input_tokens) throw new Error("Invalid cache_write_1h")
    usage.cache_creation = { ephemeral_1h_input_tokens: row.cache_write_1h }
  }
  // Hash the complete ledger row: retries sharing route_id or response_id remain
  // distinct; a replay of exactly the same log entry remains one record.
  const identity = JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))
  return {
    id: createHash("sha256").update(identity).digest("hex"),
    timestamp: new Date(row.t).toISOString(), model, usage,
  }
}

export function transcript(events) {
  return events.map(e => JSON.stringify({
    type: "assistant", timestamp: e.timestamp, sessionId: "magpie-gateway",
    requestId: e.id, message: { id: e.id, model: e.model, usage: e.usage },
  })).join("\n") + (events.length ? "\n" : "")
}

export function rebuild(payload) {
  const days = payload.contributions.sort((a, b) => a.date.localeCompare(b.date))
  const clients = new Set(), models = new Set(), years = new Map()
  let tokens = 0, cost = 0, maxCost = 0
  for (const day of days) {
    day.tokenBreakdown = zeroTokens()
    day.totals = { tokens: 0, cost: 0, messages: 0 }
    for (const row of day.clients) {
      for (const k of buckets) day.tokenBreakdown[k] += row.tokens[k] || 0
      day.totals.cost += row.cost
      day.totals.messages += row.messages
      clients.add(row.client)
      models.add(row.modelId)
    }
    day.totals.tokens = tokenTotal(day.tokenBreakdown)
    delete day.activeTimeMs // Cannot attribute a client's time to removed models.
    tokens += day.totals.tokens
    cost += day.totals.cost
    maxCost = Math.max(maxCost, day.totals.cost)
    const year = day.date.slice(0, 4)
    const aggregate = years.get(year) || { year, totalTokens: 0, totalCost: 0, range: { start: day.date, end: day.date } }
    aggregate.totalTokens += day.totals.tokens
    aggregate.totalCost += day.totals.cost
    aggregate.range.end = day.date
    years.set(year, aggregate)
  }
  const start = days[0]?.date, end = days.at(-1)?.date
  if (start) payload.meta.dateRange = { start, end }
  payload.summary = {
    totalTokens: tokens, totalCost: cost,
    totalDays: start ? Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1 : 0,
    activeDays: days.filter(d => d.totals.tokens > 0).length,
    averagePerDay: days.length ? cost / days.length : 0,
    maxCostInSingleDay: maxCost, clients: [...clients].sort(), models: [...models].sort(),
  }
  payload.years = [...years.values()]
  delete payload.timeMetrics
  if (payload.clientManifest) {
    payload.clientManifest.clients = payload.clientManifest.clients.filter(c => clients.has(c.client))
    if (!payload.clientManifest.clients.length) delete payload.clientManifest
  }
  return payload
}

export function filterLocal(source, config, bounds = {}) {
  const payload = structuredClone(source)
  let excludedTokens = 0, excludedRows = 0
  const affected = new Map()
  payload.contributions = payload.contributions.filter(day =>
    (!bounds.since || day.date >= bounds.since) && (!bounds.until || day.date <= bounds.until))
  for (const day of payload.contributions) {
    day.clients = day.clients.filter(row => {
      if (!localOwned(row, day.date, config)) return true
      excludedTokens += tokenTotal(row.tokens)
      excludedRows++
      affected.set(row.client, row)
      return false
    })
  }
  // tokens 27.0 counted OMP under pi. Preserve that identity when upgrading
  // its scanner, otherwise old pi totals and new omp totals coexist remotely.
  if (config.local.legacyPi) {
    const merge = rows => {
      const grouped = new Map()
      for (const row of rows) {
        if (row.client === "omp") row.client = "pi"
        const key = JSON.stringify([row.client, row.providerId, row.modelId])
        const previous = grouped.get(key)
        if (!previous) { grouped.set(key, row); continue }
        for (const k of buckets) previous.tokens[k] += row.tokens[k] || 0
        previous.cost += row.cost
        previous.messages += row.messages
        delete previous.speedUsage
        if (previous.provenance) previous.provenance.messageCount = previous.messages
      }
      return [...grouped.values()]
    }
    for (const day of payload.contributions) day.clients = merge(day.clients)
    if (affected.has("omp")) {
      affected.set("pi", { ...affected.get("omp"), client: "pi" })
      affected.delete("omp")
    }
    if (payload.clientManifest) {
      const manifests = new Map()
      for (const entry of payload.clientManifest.clients) {
        if (entry.client === "omp") entry.client = "pi"
        manifests.set(entry.client, entry)
      }
      payload.clientManifest.clients = [...manifests.values()]
    }
  }
  payload.contributions = payload.contributions.filter(d => d.clients.length)
  if (bounds.replace) {
    if (!bounds.since || !bounds.until || bounds.since > bounds.until) {
      throw new Error("--replace requires --since YYYY-MM-DD and --until YYYY-MM-DD")
    }
    // Tokens requires a contribution even for a fully excluded client. A zero
    // row plus full coverage replaces its prior alias totals without fake usage.
    for (const [client, original] of affected) {
      if (payload.contributions.some(d => d.clients.some(c => c.client === client))) continue
      const zero = { ...original, tokens: zeroTokens(), cost: 0, messages: 0, speedUsage: [] }
      if (zero.provenance) zero.provenance = { ...zero.provenance, messageCount: 0, modelCount: 0 }
      let day = payload.contributions.find(d => d.date === bounds.since)
      if (!day) {
        day = { date: bounds.since, clients: [], intensity: 0 }
        payload.contributions.push(day)
      }
      day.clients.push(zero)
    }
    payload.clientManifest ||= { schemaVersion: 1, clients: [] }
    for (const [client, original] of affected) {
      let entry = payload.clientManifest.clients.find(c => c.client === client)
      if (!entry) {
        entry = { client, parserRevision: original.provenance?.schemaVersion || 1 }
        payload.clientManifest.clients.push(entry)
      }
      entry.coverage = { mode: "full", start: bounds.since, end: bounds.until, missingData: "tombstone" }
    }
  }
  return { payload: rebuild(payload), excludedTokens, excludedRows }
}
