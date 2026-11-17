import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, symlink, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

test("npm-style executable symlink dispatches help, init and official login", async t => {
  const home = await mkdtemp(join(tmpdir(), "magpie-cli-link-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const bin = join(home, "bin", "magpie-tokensci")
  await mkdir(join(home, "bin"))
  await symlink(fileURLToPath(new URL("../cli.mjs", import.meta.url)), bin)
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
    TOKENS_CONFIG_DIR: join(home, "tokens") }
  delete env.TOKENS_API_TOKEN
  const invoke = args => exec(process.execPath, [bin, ...args], { env, timeout: 15000 })
  assert.match((await invoke(["--help"])).stdout, /gateway \[--dry-run\]/)
  const config = join(home, "partition.json")
  await invoke(["init", "--config", config, "--from", "2026-11-18", "--timezone", "Asia/Shanghai"])
  assert.equal(JSON.parse(await readFile(config, "utf8")).from, "2026-11-18")
  await mkdir(env.TOKENS_CONFIG_DIR)
  await writeFile(join(env.TOKENS_CONFIG_DIR, "credentials.json"), JSON.stringify({
    token: "fixture-only", username: "symlink-login-test", createdAt: "2026-11-17T00:00:00Z",
  }))
  const login = await invoke(["login"])
  assert.match(login.stdout, /Already logged in as symlink-login-test/)
  assert.match(login.stdout, /tokens logout/)
})
