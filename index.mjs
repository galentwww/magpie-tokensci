import { defaultConfig, loadConfig, startLoop } from "./reporter.mjs"

// No request/response hooks: the gateway's durable ledger is the source of truth.
// Installing the package alone never starts uploading. Enable only after the
// same partition and local exclusion have been configured on both machines.
export default async function MagpieTokensci(_input, options = {}) {
  const config = options.config || defaultConfig()
  let settings
  try { settings = await loadConfig(config) }
  catch (error) {
    if (error.code === "ENOENT") {
      console.log("magpie-tokensci: run magpie-tokensci init, configure the partition, then enable gateway.enabled")
      return {}
    }
    throw error
  }
  if (settings.gateway.enabled) startLoop("gateway", { config }, message => console.log(`magpie-tokensci: ${message}`))
  return {}
}
