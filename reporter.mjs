import { createReadStream } from "node:fs"
import { mkdir, readFile, writeFile, rename, open, truncate, unlink } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { randomUUID, createHash } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { dayAt, validateConfig, gatewayEvent, transcript, filterLocal } from "./accounting.mjs"

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
export const defaultConfig = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie-tokensci", "config.json")
const tokensConfig = () => process.env.TOKENS_CONFIG_DIR || join(homedir(), ".config", "tokens")

export async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")) }
  catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error }
}

export async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, value, { mode: 0o600 })
    await rename(temp, path)
  } finally { await unlink(temp).catch(() => {}) }
}

export async function loadConfig(path = defaultConfig()) {
  const config = validateConfig(await readJSON(path))
  config.stateDir = resolve(config.stateDir || join(dirname(path), "state"))
  return config
}

export async function initialize(path, options = {}) {
  const timezone = options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone
  const tomorrow = dayAt(Date.now() + 86400000, timezone)
  const config = {
    from: options.from || tomorrow, timezone, models: ["group/smart-using"], intervalMinutes: 30,
    local: { clients: ["pi", "omp"], providers: ["magpie"], legacyPi: true },
    gateway: {
      enabled: false, agents: ["omp"], callerKeyIds: [], allCallers: false,
      logs: [join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie", "usage.jsonl")],
    },
  }
  validateConfig(config)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  // Initialization must never overwrite an established partition.
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  return config
}

async function withLock(path, fn) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  for (let attempt = 0; ; attempt++) {
    try {
      const file = await open(path, "wx", 0o600)
      await file.writeFile(String(process.pid))
      await file.close()
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      const pid = Number(await readFile(path, "utf8"))
      if (!Number.isInteger(pid) || pid < 1) throw new Error(`Invalid lock: ${path}`)
      try { process.kill(pid, 0) }
      catch (check) {
        if (check.code === "ESRCH" && attempt === 0) { await unlink(path); continue }
        throw check
      }
      throw new Error(`Reporter already running (pid ${pid})`)
    }
  }
  try { return await fn() } finally { await unlink(path) }
}

function partitionHash(config) {
  const policy = {
    from: config.from, timezone: config.timezone, models: [...config.models].sort(),
    local: config.local, agents: [...config.gateway.agents].sort(),
    callerKeyIds: [...config.gateway.callerKeyIds].sort(), allCallers: !!config.gateway.allCallers,
  }
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex")
}

async function pinPartition(config, role) {
  const path = join(config.stateDir, role, "partition.json")
  const fingerprint = partitionHash(config)
  const previous = await readJSON(path, null)
  if (previous && previous.fingerprint !== fingerprint) {
    throw new Error(`Partition changed: ${path}. Use a planned migration; do not change an active partition in place.`)
  }
  if (!previous) await atomicWrite(path, JSON.stringify({ fingerprint }))
}

// Only committed newline-terminated ledger records are read. A partial append is
// left for the next pass; malformed complete rows abort rather than vanish.
export async function* completeLines(path) {
  const stream = createReadStream(path, { encoding: "utf8" })
  let pending = ""
  try {
    for await (const chunk of stream) {
      pending += chunk
      let at
      while ((at = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, at)
        pending = pending.slice(at + 1)
        if (line.trim()) yield line
      }
    }
  } finally { stream.destroy() }
}

export async function collectGateway(config) {
  if (!config.gateway.allCallers && !config.gateway.callerKeyIds.length) {
    throw new Error("Set gateway.callerKeyIds to your key IDs, or explicitly set allCallers=true for a private gateway")
  }
  const root = join(config.stateDir, "gateway")
  const journal = join(root, "events.jsonl")
  await mkdir(root, { recursive: true, mode: 0o700 })
  // Repair an interrupted write to our journal, never the Magpie source log.
  let stored = ""
  try { stored = await readFile(journal, "utf8") }
  catch (error) { if (error.code !== "ENOENT") throw error }
  const end = stored.lastIndexOf("\n") + 1
  if (end < stored.length) {
    await truncate(journal, Buffer.byteLength(stored.slice(0, end)))
    stored = stored.slice(0, end)
  }
  const events = new Map()
  for (const line of stored.split("\n")) {
    if (!line) continue
    const event = JSON.parse(line)
    events.set(event.id, event)
  }
  const file = await open(journal, "a", 0o600)
  let added = 0
  try {
    for (const log of config.gateway.logs) {
      for await (const line of completeLines(log)) {
        const event = gatewayEvent(JSON.parse(line), config)
        if (!event || events.has(event.id)) continue
        await file.writeFile(JSON.stringify(event) + "\n")
        events.set(event.id, event)
        added++
      }
    }
    await file.sync() // Commit before any network submission.
  } finally { await file.close() }
  const home = join(root, "home")
  const variant = join(home, ".cc-mirror", "magpie-gateway")
  await atomicWrite(join(variant, "variant.json"), '{"name":"magpie-gateway"}\n')
  await atomicWrite(join(variant, "config", "projects", "gateway", "usage.jsonl"),
    transcript([...events.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id))))
  const configDir = join(root, "tokens")
  await mkdir(configDir, { recursive: true, mode: 0o700 })
  // Only pricing is shared. Credentials, device IDs and client scan paths are not.
  for (const name of ["custom-pricing.json"]) {
    try { await atomicWrite(join(configDir, name), await readFile(join(tokensConfig(), name))) }
    catch (error) { if (error.code !== "ENOENT") throw error }
  }
  await atomicWrite(join(configDir, "settings.json"), JSON.stringify({ timezone: config.timezone }))
  const env = {}
  for (const key of ["PATH", "TMPDIR", "TEMP", "SYSTEMROOT", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA"]) {
    if (process.env[key]) env[key] = process.env[key]
  }
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"),
    TOKENS_CONFIG_DIR: configDir, TOKENS_API_TOKEN: "preview-only", TOKENS_DEVICE_NAME: "Magpie gateway", TZ: config.timezone })
  return { env, added, records: events.size }
}

export async function officialTokens(args, options = {}) {
  let command, prefix
  if (options.tokensBin) { command = options.tokensBin; prefix = [] }
  else {
    const manifest = require.resolve("tokens-cli/package.json")
    command = process.execPath
    prefix = [join(dirname(manifest), "bin.js")]
  }
  if (options.interactive) {
    await new Promise((accept, reject) => {
      const child = spawn(command, [...prefix, ...args], { env: options.env || process.env, stdio: "inherit" })
      child.once("error", reject)
      child.once("exit", code => code === 0 ? accept() : reject(new Error(`tokens exited with ${code}`)))
    })
    return { stdout: "", stderr: "" }
  }
  return exec(command, [...prefix, ...args], {
    env: options.env || process.env, maxBuffer: 256 * 1024 * 1024, timeout: 180000,
  })
}

async function exportPayload(role, config, options) {
  let env, collection
  if (role === "gateway") {
    collection = await collectGateway(config)
    if (!collection.records) return { payload: null, collection }
    env = collection.env
  } else {
    const settings = await readJSON(join(tokensConfig(), "settings.json"), {})
    if (settings.timezone && settings.timezone !== config.timezone) {
      throw new Error(`Tokens timezone ${settings.timezone} differs from partition ${config.timezone}`)
    }
    env = { ...process.env, TZ: config.timezone, TOKENS_API_TOKEN: "preview-only" }
  }
  const args = ["submit", "--dry-run", "--json"]
  if (role === "gateway") args.push("--client", "claude")
  if (options.since) args.push("--since", options.since)
  if (options.until) args.push("--until", options.until)
  let result
  try { result = await officialTokens(args, { ...options, env }) }
  catch (error) {
    throw new Error(`Tokens JSON export failed. This package requires tokens-cli 27.2.1 or newer. ${error.stderr || error.message}`)
  }
  if (!result.stdout.trim()) return { payload: null, collection }
  const payload = JSON.parse(result.stdout)
  // The Rust exporter iterates hash maps. Keep identical snapshots identical
  // across retries, independently of its model row enumeration order.
  payload.contributions.sort((a, b) => a.date.localeCompare(b.date))
  for (const day of payload.contributions) {
    day.clients.sort((a, b) => JSON.stringify([a.client, a.providerId, a.modelId])
      .localeCompare(JSON.stringify([b.client, b.providerId, b.modelId])))
  }
  if (role === "gateway") return { payload, collection }
  return { ...filterLocal(payload, config, options), collection }
}

async function credentials() {
  const token = process.env.TOKENS_API_TOKEN || (await readJSON(join(tokensConfig(), "credentials.json"), {})).token
  if (!token) throw new Error("Not logged in. Run magpie-tokensci login on this machine first.")
  return token
}

export async function postPayload(payload, options = {}) {
  const base = process.env.TOKENS_API_URL || "https://tokens.ci"
  const url = new URL("/api/submit", base)
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Tokens submission requires HTTPS (except loopback tests)")
  }
  const token = options.token || await credentials()
  const response = await fetch(url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(120000),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(`Tokens submission failed: HTTP ${response.status}`)
  const body = await response.json()
  if (body.error || !body.submissionId) throw new Error("Tokens returned no successful submission ID")
  return body
}

export async function run(role, options = {}) {
  if (!["gateway", "local"].includes(role)) throw new Error("Role must be gateway or local")
  if (options.replace && role !== "local") throw new Error("--replace is only for local history migration")
  if (options.replace && (!options.since || !options.until)) throw new Error("--replace requires explicit --since and --until")
  const config = await loadConfig(options.config)
  return withLock(join(config.stateDir, role, "report.lock"), async () => {
    await pinPartition(config, role)
    const result = await exportPayload(role, config, options)
    if (result.payload && !options.dryRun && (result.payload.summary.totalTokens || options.replace)) {
      result.response = await postPayload(result.payload)
      await atomicWrite(join(config.stateDir, role, "last-submit.json"), JSON.stringify({
        at: new Date().toISOString(), summary: result.payload.summary, submissionId: result.response.submissionId,
      }, null, 2) + "\n")
    }
    return result
  })
}

export function startLoop(role, options = {}, report = console.log) {
  let stopped = false
  let timer
  const tick = async () => {
    if (stopped) return
    let minutes = 30
    try {
      const config = await loadConfig(options.config)
      minutes = config.intervalMinutes
      const result = await run(role, options)
      report(JSON.stringify({ role, summary: result.payload?.summary || null,
        excludedTokens: result.excludedTokens || 0, submissionId: result.response?.submissionId || null,
        warnings: result.response?.warnings || [] }))
    } catch (error) { report(`${role}: ${error.message}`) }
    if (!stopped) timer = setTimeout(tick, minutes * 60000)
  }
  void tick()
  return () => { stopped = true; clearTimeout(timer) }
}

export async function listCallers(config) {
  const counts = new Map()
  for (const log of config.gateway.logs) {
    for await (const line of completeLines(log)) {
      const row = JSON.parse(line)
      if (!config.models.includes(row.req) || !config.gateway.agents.includes(row.agent)) continue
      const key = row.callerKeyId || "(no callerKeyId)"
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  return Object.fromEntries(counts)
}
