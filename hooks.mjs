// magpie 网关钩子：把 magpie 路由过的调用补记成一条 tokens 能读的记录。
//
// 默认什么都不写，因为补记只在一种情况下有用：agent 自己的会话文件 tokens
// 根本不读。那种 agent 的用量否则完全看不见，补记不会和谁重复。
//
// 反过来，agent 的会话文件 tokens 已经在读时，补记就是同一笔用量记两遍。
// 实测：omp 一次调用（510 tokens）补记后变成 1,020 tokens——tokens 的 pi 车道
// 按 `pi:entry:<id>:<时间戳>` 去重，补记的记录拿不到那个 id，两份都算进去。
// 所以下面有一份硬名单：这些 agent 的用量 tokens 自己会读到，插件拒绝镜像，
// 只在日志里说一次。
//
// 开启方式（只列 tokens 读不到的 agent）：
//
//   magpie plugin options magpie-tokensci '{"mirrorAgents":["ClaudeDesktop"]}'
//
// 记录写成 Claude Code 的会话形状，放在 ~/.cc-mirror/magpie 这个变体下，tokens
// 把它读成 client `cc-mirror/magpie`，按模型名查价。模型名取自回复——同包的
// served-model 中间件已经把它换成了实际服务的模型。
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const VARIANT = "magpie"
const home = homedir()
const projectsDir = join(home, ".cc-mirror", VARIANT, "config", "projects")

// COUNTED_BY_TOKENS 是 tokens 自己会扫描的 client（cli/tokens-core/src/clients.rs
// 的列表，加上它按 cc-mirror 变体认的 claude）。这些 agent 的用量已经在
// tokens 的统计里，镜像它们只会重复计数。
const COUNTED_BY_TOKENS = new Set([
  "amp", "antigravity", "antigravity-cli", "augment", "cherrystudio", "claude",
  "cline", "codebuddy", "codebuff", "codex", "commandcode", "copilot", "craft-agent",
  "crush", "cursor", "droid", "dsh", "devin", "devin-cli", "devin-desktop", "freebuff",
  "fx", "gemini", "gjc", "goose", "grok", "hermes", "hindsight", "jcode", "junie",
  "kilo", "kilocode", "kimchi", "kimi", "kiro", "lmstudio", "mcode", "micode", "mux",
  "omp", "openclaw", "opencode", "opencodereview", "pi", "prime-agent", "qwen",
  "reasonix", "roocode", "senpi", "synthetic", "trae", "unsloth", "warp", "workbuddy",
  "zcode", "zed", "9router",
])

// slug 是 Claude Code 给工作目录起的目录名。
const slug = (cwd) => (cwd ? cwd.replace(/[^A-Za-z0-9]/g, "-") : "-magpie")

// usageOf 按 agent 说的 API 取出 token 数。四个 API 的字段名各不相同。
function usageOf(protocol, reply) {
  const n = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
  if (protocol === "anthropic") {
    const u = reply.usage || {}
    return { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) }
  }
  if (protocol === "chat" || protocol === "responses") {
    const u = reply.usage || {}
    const d = (protocol === "chat" ? u.prompt_tokens_details : u.input_tokens_details) || {}
    const prompt = protocol === "chat" ? u.prompt_tokens : u.input_tokens
    return {
      input: n(prompt) - n(d.cached_tokens) - n(d.cache_write_tokens),
      output: n(protocol === "chat" ? u.completion_tokens : u.output_tokens),
      cacheRead: n(d.cached_tokens),
      cacheWrite: n(d.cache_write_tokens),
    }
  }
  const u = reply.usageMetadata || reply.usage || {}
  return {
    input: n(u.promptTokenCount) - n(u.cachedContentTokenCount),
    output: n(u.candidatesTokenCount) + n(u.thoughtsTokenCount),
    cacheRead: n(u.cachedContentTokenCount),
    cacheWrite: 0,
  }
}

function ensureVariant() {
  mkdirSync(projectsDir, { recursive: true })
  const file = join(home, ".cc-mirror", VARIANT, "variant.json")
  try {
    readFileSync(file)
  } catch {
    appendFileSync(file, JSON.stringify({ name: VARIANT }) + "\n")
  }
}

// told 记住已经拒绝过的 agent，一个 agent 只记一次日志。
const told = new Set()

export async function onRequest(body, ctx) {
  ctx.state.pre = {
    agent: ctx.agent || "",
    session: ctx.session || "",
    cwd: ctx.cwd || "",
    protocol: ctx.protocol,
  }
  return undefined
}

export async function onResponse(reply, ctx) {
  const pre = ctx.state.pre
  if (!pre || !ctx.success || !reply) return
  const mirror = (ctx.options && ctx.options.mirrorAgents) || []
  if (!mirror.includes(pre.agent)) return

  const agent = pre.agent.toLowerCase()
  if (COUNTED_BY_TOKENS.has(agent)) {
    if (!told.has(agent)) {
      told.add(agent)
      console.log(`${pre.agent} is already counted by tokens from its own sessions; not mirroring it (that would count its usage twice)`)
    }
    return
  }

  const usage = usageOf(pre.protocol, reply)
  if (!usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite) return

  const at = Date.now()
  const responseId = reply.id || `magpie-${at}`
  const session = pre.session || responseId

  ensureVariant()
  const dir = join(projectsDir, slug(pre.cwd))
  mkdirSync(dir, { recursive: true })
  appendFileSync(
    join(dir, `${session}.jsonl`),
    JSON.stringify({
      type: "assistant",
      timestamp: new Date(at).toISOString(),
      sessionId: session,
      ...(pre.cwd ? { cwd: pre.cwd } : {}),
      message: {
        id: responseId,
        model: reply.model || reply.modelVersion || "unknown",
        usage: {
          input_tokens: usage.input,
          output_tokens: usage.output,
          cache_read_input_tokens: usage.cacheRead,
          cache_creation_input_tokens: usage.cacheWrite,
        },
      },
    }) + "\n",
  )
  return undefined
}
