#!/usr/bin/env node
import { parseArgs } from "node:util"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { defaultConfig, initialize, loadConfig, run, officialTokens, startLoop, listCallers } from "./reporter.mjs"

const help = `magpie-tokensci 0.2.0

  init [--from YYYY-MM-DD] [--timezone Asia/Shanghai]  Create a shared partition config
  callers                                           List matching gateway caller key IDs
  gateway [--dry-run]                                Report actual models from Magpie logs
  local [--dry-run]                                  Submit local usage excluding gateway-owned models
  serve gateway|local                               Submit periodically (foreground service)
  login                                             Authenticate to tokens.ci using its official CLI

Options:
  --config FILE          Config path (default: ${defaultConfig()})
  --since YYYY-MM-DD      Restrict a report to dates on/after this day
  --until YYYY-MM-DD      Restrict a report to dates on/before this day
  --replace              Local-only authoritative history correction; needs both date bounds
  --tokens-bin PATH      Use another tokens binary supporting --dry-run --json

Preview writes no network submission. Never run unfiltered tokens serve alongside local reporting.
`

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: "string" }, from: { type: "string" }, timezone: { type: "string" },
    since: { type: "string" }, until: { type: "string" }, "dry-run": { type: "boolean", default: false },
    replace: { type: "boolean", default: false }, "tokens-bin": { type: "string" },
    help: { type: "boolean", short: "h" },
  } })
  const [command, role] = positionals
  if (!command || values.help) { console.log(help); return }
  const configPath = resolve(values.config || defaultConfig())
  const options = { config: configPath, since: values.since, until: values.until,
    replace: values.replace, dryRun: values["dry-run"], tokensBin: values["tokens-bin"] }
  for (const key of ["since", "until", "from"]) {
    if (values[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(values[key]) ||
        new Date(values[key]).toISOString().slice(0, 10) !== values[key])) {
      throw new Error(`--${key} requires a calendar date YYYY-MM-DD`)
    }
  }
  if (positionals.length > (command === "serve" ? 2 : 1)) throw new Error("Unexpected positional arguments")
  if (command === "init") {
    const config = await initialize(configPath, values)
    console.log(JSON.stringify({ config: configPath, ...config }, null, 2))
  } else if (command === "login") {
    // The official CLI owns device-code authentication. No token in argv or config.
    await officialTokens(["login"], { ...options, interactive: true })
  } else if (command === "callers") {
    console.log(JSON.stringify(await listCallers(await loadConfig(configPath)), null, 2))
  } else if (command === "serve") {
    if (!["gateway", "local"].includes(role)) throw new Error("serve requires gateway or local")
    if (options.replace) throw new Error("Run --replace as a one-time local command, never in serve")
    const stop = startLoop(role, options)
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stop(); process.exitCode = 0 })
  } else if (["gateway", "local"].includes(command)) {
    const result = await run(command, options)
    if (options.dryRun) console.log(JSON.stringify(result.payload, null, 2))
    else console.log(JSON.stringify(result.response || { skipped: true, summary: result.payload?.summary }, null, 2))
    console.error(JSON.stringify({ excludedTokens: result.excludedTokens || 0, excludedRows: result.excludedRows || 0,
      gatewayRecords: result.collection?.records || 0, newlyCollected: result.collection?.added || 0 }))
  } else throw new Error(`Unknown command: ${command}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
