import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { dayAt } from "../accounting.mjs"
import { run, collectGateway, loadConfig, initialize } from "../reporter.mjs"

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "magpie-accounting-test-"))
  const env = { ...process.env }
  for (const k of Object.keys(process.env)) {
    if (/^(TOKENS_|PI_|OMP_|XDG_|CODEX_HOME|CLAUDE_CONFIG_DIR|GJC_|GEMINI_CLI_HOME)/.test(k)) delete process.env[k]
  }
  Object.assign(process.env, { HOME: root, XDG_CONFIG_HOME: join(root, ".config"),
    XDG_DATA_HOME: join(root, ".local", "share"), XDG_CACHE_HOME: join(root, ".cache"), TZ: "Asia/Shanghai" })
  t.after(async () => {
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]
    Object.assign(process.env, env)
    await rm(root, { recursive: true, force: true })
  })
  const native = join(root, ".config", "tokens")
  await mkdir(native, { recursive: true })
  await writeFile(join(native, "device.json"), JSON.stringify({ id: "dev_local_only", createdAt: new Date().toISOString() }))
  await writeFile(join(native, "credentials.json"), JSON.stringify({ token: "fixture-token", username: "test", createdAt: new Date().toISOString() }))
  await writeFile(join(native, "settings.json"), JSON.stringify({ timezone: "Asia/Shanghai" }))
  await writeFile(join(native, "custom-pricing.json"), JSON.stringify({ models: {
    "claude-opus-5-5": { input_cost_per_million_tokens: 4, output_cost_per_million_tokens: 20 },
    "claude-sonnet-4": { input_cost_per_million_tokens: 1, output_cost_per_million_tokens: 5 },
  } }))
  const today = dayAt(Date.now(), "Asia/Shanghai")
  const configPath = join(root, "partition.json")
  const config = await initialize(configPath, { from: today, timezone: "Asia/Shanghai" })
  config.gateway.logs = [join(root, "usage.jsonl")]
  config.gateway.callerKeyIds = ["mine"]
  await writeFile(configPath, JSON.stringify(config))
  const ledger = (id, extra = {}) => ({
    route_id: id, t: `${today}T00:00:00+08:00`, agent: "omp", callerKeyId: "mine",
    req: "group/smart-using", model: "claude-opus-5-5", served: "claude-opus-5-5",
    in: 1000000, out: 0, cache_read: 0, cache_write: 0, status: 200,
    response_id: "upstream-reused-response-id", ...extra,
  })
  return { root, today, configPath, config, ledger }
}

test("official tokens prices gateway models, local partition retains other models, and uploads are repeatable", async t => {
  const f = await fixture(t)
  const events = [f.ledger(1), f.ledger(2, { served: "claude-sonnet-4" }),
    f.ledger(3, { callerKeyId: "other-person" }), f.ledger(4, { req: "group/other" })]
  await writeFile(f.config.gateway.logs[0], events.map(JSON.stringify).join("\n") + "\n")
  const sessions = join(f.root, ".omp", "agent", "sessions", "project")
  await mkdir(sessions, { recursive: true })
  const usage = { input: 1000000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1000000 }
  const assistant = (id, model) => ({ type: "message", id, timestamp: `${f.today}T00:01:00+08:00`,
    message: { role: "assistant", provider: "magpie", model, usage } })
  await writeFile(join(sessions, "session.jsonl"), [
    { type: "session", id: "session", timestamp: `${f.today}T00:00:00+08:00`, cwd: "/test" },
    assistant("alias-1", "group/smart-using"), assistant("alias-2", "group/smart-using"),
    assistant("direct-1", "claude-opus-5-5"),
  ].map(JSON.stringify).join("\n") + "\n")
  const options = { config: f.configPath, dryRun: true }
  const gateway = await run("gateway", options)
  assert.equal(gateway.payload.summary.totalTokens, 2000000)
  assert.equal(gateway.payload.summary.totalCost, 5)
  assert.deepEqual(gateway.payload.summary.models.sort(), ["claude-opus-5-5", "claude-sonnet-4"])
  // Reported under the familiar `omp` identity the gateway serves for this user.
  assert.equal(gateway.payload.contributions[0].clients[0].client, "omp")
  const local = await run("local", options)
  assert.equal(local.excludedTokens, 2000000)
  assert.equal(local.payload.summary.totalTokens, 1000000)
  assert.equal(local.payload.summary.totalCost, 4)
  assert.deepEqual(local.payload.summary.models, ["claude-opus-5-5"])
  assert.equal(local.payload.device.id, "dev_local_only")
  assert.deepEqual(local.payload.summary.clients, ["pi"])
  assert.notEqual(gateway.payload.device.id, local.payload.device.id)
  // Exact gateway replay plus local direct usage sums to three million, never five.
  assert.equal(gateway.payload.summary.totalTokens + local.payload.summary.totalTokens, 3000000)
  const replay = await run("gateway", options)
  assert.equal(replay.collection.added, 0)
  assert.equal(replay.payload.device.id, gateway.payload.device.id)
  assert.equal(replay.payload.summary.totalTokens, gateway.payload.summary.totalTokens)

  const uploads = []
  let fail = true
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    assert.equal(req.url, "/api/submit")
    assert.equal(req.headers.authorization, "Bearer fixture-token")
    uploads.push(JSON.parse(Buffer.concat(chunks)))
    res.setHeader("content-type", "application/json")
    if (fail) { res.writeHead(503); res.end('{"error":"unavailable"}') }
    else res.end(JSON.stringify({ submissionId: `submission-${uploads.length}`, warnings: [] }))
  })
  await new Promise(accept => server.listen(0, "127.0.0.1", accept))
  t.after(() => new Promise(accept => server.close(accept)))
  process.env.TOKENS_API_URL = `http://127.0.0.1:${server.address().port}`
  await assert.rejects(run("gateway", { config: f.configPath }), /HTTP 503/)
  await assert.rejects(readFile(join(f.root, "state", "gateway", "last-submit.json")), { code: "ENOENT" })
  fail = false
  const accepted = await run("gateway", { config: f.configPath })
  assert.equal(accepted.response.submissionId, "submission-2")
  assert.deepEqual(uploads[0].contributions, uploads[1].contributions)
  assert.equal(uploads[0].device.id, uploads[1].device.id)
  assert.equal(uploads[1].summary.totalCost, 5)
  await run("local", { config: f.configPath })
  assert.equal(uploads.at(-1).summary.totalTokens, 1000000)
  const zeroMigration = await run("local", { ...options, replace: true, since: f.today, until: f.today })
  assert.equal(zeroMigration.payload.clientManifest.clients.find(c => c.client === "pi").coverage.mode, "full")
  // No source transcripts, login files, or device files were rewritten.
  assert.equal(JSON.parse(await readFile(join(f.root, ".config", "tokens", "device.json"))).id, "dev_local_only")
  assert.equal((await readFile(join(sessions, "session.jsonl"), "utf8")).includes("group/smart-using"), true)
})

test("ledger replay, truncated append, journal crash repair and source rotation preserve exactly one copy", async t => {
  const f = await fixture(t)
  const config = await loadConfig(f.configPath)
  const first = JSON.stringify(f.ledger(1))
  const second = JSON.stringify(f.ledger(2))
  const half = Math.floor(second.length / 2)
  await writeFile(config.gateway.logs[0], first + "\n" + first + "\n" + second.slice(0, half))
  assert.equal((await collectGateway(config)).records, 1)
  await appendFile(config.gateway.logs[0], second.slice(half) + "\n")
  assert.equal((await collectGateway(config)).records, 2)
  const journal = join(config.stateDir, "gateway", "events.jsonl")
  await appendFile(journal, '{"interrupted":')
  // Magpie rotated/truncated its source after collection. Journal retains history.
  await writeFile(config.gateway.logs[0], JSON.stringify(f.ledger(3, { status: 499 })) + "\n")
  const restored = await collectGateway(config)
  assert.equal(restored.records, 3)
  assert.equal(restored.added, 1)
  assert.equal((await collectGateway(config)).added, 0)
  assert.equal((await readFile(journal, "utf8")).trim().split("\n").length, 3)
  config.gateway.callerKeyIds = []
  await assert.rejects(collectGateway(config), /callerKeyIds/)
  await writeFile(config.gateway.logs[0], "not JSON\n")
  config.gateway.callerKeyIds = ["mine"]
  await assert.rejects(collectGateway(config), SyntaxError)
})

test("configuration changes cannot silently reassign submitted data", async t => {
  const f = await fixture(t)
  await writeFile(f.config.gateway.logs[0], JSON.stringify(f.ledger(1)) + "\n")
  await run("gateway", { config: f.configPath, dryRun: true })
  f.config.models = ["group/other"]
  await writeFile(f.configPath, JSON.stringify(f.config))
  await assert.rejects(run("gateway", { config: f.configPath, dryRun: true }), /Partition changed/)
})
