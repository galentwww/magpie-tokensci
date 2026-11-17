// magpie 网关中间件：让回复里的 model 是实际服务的模型，而不是 agent 请求的
// 别名。
//
// 为什么需要：magpie 把 agent 请求的模型名原样回显（`group/xxx`、
// `provider/model`）。agent 把它写进自己的会话文件后，tokens.ci 拿到的是一个
// 定价表里不存在的别名：成本算成 0，模型统计也归到别名上。实测同一笔
// 1,000,000 input tokens：记成 `claude-opus-5-5` 是 $4.00，记成 `group/demo`
// 是 $0.00。
//
// onProvider 在请求即将发给某个供应商时给出实际服务的模型，onEvent /
// onResponse 在回复回去的路上写回去，agent 记录的就是真实模型。不额外写记录，
// 因此不会重复计数。只改 model 字段，不动正文、工具调用和 usage。
export function onProvider(body, ctx) {
  const provider = ctx.provider || {}
  ctx.state.served = provider.model || ""
  return undefined
}

export function onEvent(ev, ctx) {
  const served = ctx.state.served
  if (!served || !ev) return undefined
  if (ctx.protocol === "anthropic") {
    if (ev.type === "message_start" && ev.message) ev.message.model = served
  } else if (ctx.protocol === "responses") {
    if (ev.response) ev.response.model = served
  } else if (ctx.protocol === "chat") {
    if ("model" in ev) ev.model = served
  } else if (ctx.protocol === "gemini") {
    if ("modelVersion" in ev) ev.modelVersion = served
  }
  return ev
}

export function onResponse(body, ctx) {
  const served = ctx.state.served
  if (!served || !body) return undefined
  if (ctx.protocol === "gemini") {
    if ("modelVersion" in body) body.modelVersion = served
  } else if ("model" in body) {
    body.model = served
  }
  return body
}
