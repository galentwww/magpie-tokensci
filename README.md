# magpie-tokensci

让 [tokens.ci](https://tokens.ci) 按 magpie 路由后**实际服务的模型**计价。

## 问题

magpie 的网关把 agent 请求的模型名原样回显：`group/auto`、`provider/model`。
agent 把它写进自己的会话文件，tokens 读到的就是一个定价表里不存在的别名。

实测同一笔 1,000,000 input tokens：

| 会话文件记的模型 | tokens 算出的成本 |
| --- | --- |
| `claude-opus-5-5` | $4.00 |
| `group/demo` | $0.00 |

成本归零，模型统计也全归到别名上。本机 omp 一天 4.15 亿 tokens 就记在
`group/smart-using` 名下，成本显示 $0。

## 解决

本包是一个 magpie 插件，两部分。

### `served-model.middleware.js`（默认开启，主路径）

网关中间件。`onProvider` 在请求发出前拿到实际服务的模型，`onEvent` /
`onResponse` 在回复回去的路上把它写回 `model` 字段。只改模型名，不动正文、
工具调用和 usage。

对**记录回复模型**的 agent 就够用了——Claude Code 是其中之一：它把回复里的
`model` 写进 `~/.claude/projects/**/*.jsonl`，tokens 直接读到真实模型。不额外
写任何记录，因此不会重复计数。

四种协议（Anthropic Messages、Chat Completions、Responses、Gemini）的流式与
非流式回复都已验证。

### `hooks.mjs`（默认关闭，补记）

异步网关钩子，给 tokens 根本不扫描的 agent 补一条记录，写成 Claude Code 的
会话形状放在 `~/.cc-mirror/magpie` 下，tokens 把它读成 client
`cc-mirror/magpie`。

## 安装

```sh
magpie plugin add /path/to/magpie-tokensci
```

需要 magpie 0.1.2xxx 或更新才有效（`onProvider` 中间件钩子 2026-10-17 加入）。
旧版 magpie 上插件照样加载，但什么都不改——旧版本来就把实际服务的模型写在
回复里，不需要本包。

## 补记（可选）

只对 tokens 读不到的 agent 开启：

```sh
magpie plugin options magpie-tokensci '{"mirrorAgents":["ClaudeDesktop"]}'
```

`mirrorAgents` 里的名字是 magpie 在请求上认出的 agent id（钩子的 `ctx.agent`，
例如 `ClaudeDesktop`、`Raycast`）。查它最直接的办法是开着插件跑一次那个
agent，然后看 magpie 的日志。

**硬性防护。** tokens 自己会扫描的 agent（`claude`、`codex`、`opencode`、
`pi`、`omp`、`gemini`、`cursor` 等）即使写进 `mirrorAgents` 也会被拒绝，
只在日志里说一次。原因：那些 agent 的会话文件已经记了这次调用，补记就是
同一笔用量记两遍。实测 omp 一次调用（510 tokens）补记后变成 1,020 tokens。

## 已知限制

**omp、Codex 记的是请求的模型名，不是回复的。** 这两个 agent 把**自己请求**的
模型写进会话文件（omp 的 `responseModel` 字段恒为 `null`），所以中间件改回复
不影响它们记下的名字。它们的用量仍按别名计价。

对 omp 有两条路，都不理想：

- **补记**（`mirrorAgents:["omp"]` + 让 tokens 不扫 pi 车道）。镜像记录能被正确
  计价（实测 1,000,000 input → $4.00），但必须同时让 tokens 忽略 agent 自己的
  记录，否则重复计数。tokens 的 `defaultClients` 在 CLI 里没有被读取，实际能用的
  只有 `tokens submit -c ...` 和 `tokens autosubmit` 的 `clients` 配置。
- **tokens 侧自定义价目**。`~/.config/tokens/custom-pricing.json` 可以给别名
  直接定价（实测 `group/smart-using` 也生效），但 `group/auto` 这类自动路由组
  每次可能落到不同模型，一个价目不成立。

**`modelIdPrefixesToStrip` 不是解。** 它只去掉前缀，要求剩下的正好是定价表里的
模型名；`group/auto` 去掉 `group/` 后是 `auto`，查不到。
