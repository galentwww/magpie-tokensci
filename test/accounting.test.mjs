import test from "node:test"
import assert from "node:assert/strict"
import { gatewayEvent, filterLocal, dayAt, rebuild, transcript } from "../accounting.mjs"

const config = {
  from: "2026-11-17", timezone: "Asia/Shanghai", models: ["group/smart-using"],
  local: { clients: ["pi", "omp"], providers: ["magpie"] },
  gateway: { agents: ["omp"], callerKeyIds: ["mine"] },
}
const row = (changes = {}) => ({
  t: "2026-11-17T00:00:00+08:00", route_id: 1, agent: "omp", callerKeyId: "mine",
  req: "group/smart-using", model: "claude-opus-5-5", served: "claude-opus-5-5",
  in: 100, out: 20, cache_read: 300, cache_write: 40, reasoning: 5, status: 200, ...changes,
})
const contribution = (changes = {}) => ({
  client: "omp", providerId: "magpie", modelId: "group/smart-using",
  tokens: { input: 100, output: 20, cacheRead: 300, cacheWrite: 40, reasoning: 0 },
  cost: 1, messages: 1, provenance: { schemaVersion: 1, messageCount: 1, modelCount: 1 }, ...changes,
})
function payload(days) {
  return rebuild({ device: { id: "local-device" }, meta: { version: "test", generatedAt: new Date().toISOString() },
    contributions: days, clientManifest: { schemaVersion: 1, clients: [
      { client: "omp", parserRevision: 1 }, { client: "codex", parserRevision: 4 },
    ] } })
}

test("gateway uses actual model, keeps billed failed attempts, and partitions by caller/date/agent", () => {
  const event = gatewayEvent(row({ served: "gpt-5", model: "alias", cache_write_1h: 10 }), config)
  assert.equal(event.model, "gpt-5")
  assert.equal(event.usage.output_tokens, 20) // Do not add the reasoning subset twice.
  assert.equal(event.usage.cache_creation.ephemeral_1h_input_tokens, 10)
  assert.equal(gatewayEvent(row({ callerKeyId: "someone-else" }), config), null)
  assert.equal(gatewayEvent(row({ agent: "codex" }), config), null)
  assert.equal(gatewayEvent(row({ req: "group/other" }), config), null)
  assert.equal(gatewayEvent(row({ t: "2026-11-16T15:59:59Z" }), config), null)
  assert.equal(dayAt("2026-11-16T16:00:00Z", config.timezone), config.from)
  assert.equal(gatewayEvent(row({ source: "reported" }), config), null)
  assert.equal(gatewayEvent(row({ status: 499 }), config).usage.input_tokens, 100)
  assert.equal(gatewayEvent(row({ in: 0, out: 0, cache_read: 0, cache_write: 0, status: 500 }), config), null)
  assert.throws(() => gatewayEvent(row({ in: -1 }), config), /Invalid in/)
  assert.throws(() => gatewayEvent(row({ model: "group/bad", served: "" }), config), /actual model/)
  assert.equal(gatewayEvent(row({ served: "" }), config).model, "claude-opus-5-5")
})

test("repeated response IDs do not collapse distinct requests; exact ledger replays do", () => {
  const a = gatewayEvent(row({ response_id: "reused" }), config)
  const b = gatewayEvent(row({ response_id: "reused", route_id: 2 }), config)
  assert.notEqual(a.id, b.id)
  assert.equal(gatewayEvent(row({ response_id: "reused" }), config).id, a.id)
  const events = transcript([a, b]).trim().split("\n").map(JSON.parse)
  assert.notEqual(events[0].message.id, events[1].message.id)
  assert.equal(events[0].message.usage.cache_read_input_tokens, 300)
  assert.equal("callerKeyId" in events[0], false)
})

test("local excludes only matching post-cutover provider/client/model and rebuilds totals", () => {
  const owned = contribution()
  const direct = contribution({ modelId: "google/models/gemini-4-carbon", cost: 2 })
  const differentProvider = contribution({ providerId: "other", cost: 3 })
  const codex = contribution({ client: "codex", providerId: "openai", modelId: "gpt-5", cost: 4,
    provenance: { schemaVersion: 4, messageCount: 1, modelCount: 1 } })
  const source = payload([
    { date: "2026-11-16", clients: [owned], intensity: 1 },
    { date: "2026-11-17", clients: [owned, direct, differentProvider, codex], intensity: 4 },
  ])
  const before = structuredClone(source)
  const result = filterLocal(source, config)
  assert.deepEqual(source, before)
  assert.equal(result.excludedTokens, 460)
  assert.equal(result.payload.summary.totalTokens, 1840)
  assert.equal(result.payload.summary.totalCost, 10)
  assert.equal(result.payload.contributions[0].clients[0].modelId, "group/smart-using")
  assert.equal(result.payload.contributions[1].clients.length, 3)
  assert.equal(result.payload.years[0].totalTokens, 1840)
  assert.equal(result.payload.device.id, "local-device")
  assert.equal(result.payload.clientManifest.clients.find(c => c.client === "codex").parserRevision, 4)
})

test("authoritative migration preserves native usage and represents fully excluded clients with zero rows", () => {
  const source = payload([{ date: "2026-11-17", clients: [contribution()], intensity: 1 }])
  const result = filterLocal(source, config, { replace: true, since: "2026-11-17", until: "2026-11-18" })
  assert.equal(result.payload.summary.totalTokens, 0)
  assert.equal(result.payload.contributions[0].clients[0].cost, 0)
  assert.deepEqual(result.payload.clientManifest.clients[0].coverage,
    { mode: "full", start: "2026-11-17", end: "2026-11-18", missingData: "tombstone" })
  assert.throws(() => filterLocal(source, config, { replace: true }), /requires/)
})

test("legacy OMP submissions retain pi identity and merge native Pi rows without dropping tokens", () => {
  const source = payload([{ date: "2026-11-17", intensity: 1, clients: [
    contribution(),
    contribution({ modelId: "claude-opus-5-5" }),
    contribution({ client: "pi", modelId: "claude-opus-5-5" }),
  ] }])
  const result = filterLocal(source, { ...config, local: { ...config.local, legacyPi: true } },
    { replace: true, since: "2026-11-17", until: "2026-11-17" })
  assert.equal(result.payload.summary.totalTokens, 920)
  assert.deepEqual(result.payload.summary.clients, ["pi"])
  assert.equal(result.payload.contributions[0].clients.length, 1)
  assert.equal(result.payload.contributions[0].clients[0].messages, 2)
  assert.equal(result.payload.clientManifest.clients[0].client, "pi")
  assert.equal(result.payload.clientManifest.clients[0].coverage.mode, "full")
})
