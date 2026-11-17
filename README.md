# magpie-tokensci

由 **Magpie 按实际模型上报**，本机排除对应路由别名；其他本机用量继续上报。

0.2.0 替换了 0.1.0 的回复改写和镜像钩子。现在不修改请求、回复或 agent 会话文件。
OMP、Codex 是否记录回复模型名，不再影响网关统计。

## 分工

| 运行位置 | 数据来源 | 上报范围 |
| --- | --- | --- |
| Magpie 机器 | `~/.config/magpie/usage.jsonl` | 指定 agent、调用方 key、原始请求模型，按 `served` / `model` 归属实际模型 |
| 本机 | tokens 原有扫描器 | 保留其他用量，仅删除切换日期之后匹配的 client + provider + model 汇总 |

默认规则：远端处理 `omp` 发给 `group/smart-using` 的请求；本机排除
`pi` / `omp` 客户端下 `providerId=magpie` 且 `modelId=group/smart-using` 的记录。
`google/models/gemini-4-carbon` 等其他模型继续由本机提交。

网关数据以 `omp` 客户端身份计价和提交，与你在 tokens.ci 上看到的其他 omp 记录一致。
它来自网关的独立设备身份，因此仍与本机扫描分开统计。
费用是 tokens 价目表的估算，不代表订阅实际账单。未知价格保持 tokens 的结果，
不会给自动路由组虚构一个固定价格。

## 安装与登录

需要 Node.js 22+；Magpie 插件已在 **0.1.4250** 实测。
包内依赖固定为 `tokens-cli@27.2.1`，不依赖 Homebrew 安装的旧 `tokens`。
在远端和本机分别安装：

```sh
npm install -g git+https://github.com/galentwww/magpie-tokensci.git
magpie-tokensci --help
```

仓库可直接安装，无构建步骤。npm 发布后也可用 `npm install -g magpie-tokensci`。

远端登录到与本机相同的 tokens.ci 账号：

```sh
magpie-tokensci login
```

此命令使用官方 CLI 的设备码登录；远端终端显示授权链接，在本机浏览器完成即可。
已登录的本机无需重登。也支持 `TOKENS_API_TOKEN` 环境变量。
如果显示 `Already logged in as ...`，表示该机器已有登录，不会生成新授权码。
0.2.0 的 npm 全局命令存在符号链接入口问题，可能无输出退出；升级到 0.2.1 修复。
升级后先执行 `magpie-tokensci --help`，确认命令正常输出。
凭据只从该机器的 `~/.config/tokens/credentials.json` 或 `TOKENS_CONFIG_DIR` 读取。
不要复制本机的 `device.json`：网关在自己的状态目录创建独立设备身份。

## 1. 在远端配置统计范围

用运行 Magpie 的同一个系统用户执行：

```sh
magpie-tokensci init --timezone Asia/Shanghai
magpie-tokensci callers
```

配置文件默认为 `~/.config/magpie-tokensci/config.json`（尊重 `XDG_CONFIG_HOME`）。
`init` 不覆盖已有配置；`from` 默认是该时区的**明天**，按完整日切换。
不要在尚未完成两端配置时把日期提前。

`callers` 列出匹配 `omp` / `group/smart-using` 的 `callerKeyId` 及调用数，不输出密钥。
把自己的 ID 写入 `gateway.callerKeyIds`。例如：

```json
{
  "from": "2026-11-18",
  "timezone": "Asia/Shanghai",
  "models": ["group/smart-using"],
  "intervalMinutes": 30,
  "local": {
    "clients": ["pi", "omp"],
    "providers": ["magpie"],
    "legacyPi": true
  },
  "gateway": {
    "enabled": false,
    "agents": ["omp"],
    "callerKeyIds": ["你的调用方 key ID"],
    "allCallers": false,
    "logs": ["/home/ryan/.config/magpie/usage.jsonl"]
  }
}
```

`logs` 必须是远端实际路径；macOS 通常在 `/Users/ryan/.config/magpie/usage.jsonl`。
若是只有自己使用的专用网关，可以明确设置 `allCallers: true`。共享网关不要这样做。
这会把所有符合 agent / model 条件的调用方统计到你的账号。

只筛选实际网关日志，不统计 `source` 标记的外部导入记录、内部 operation 或本地拒绝。
有实际 token 的失败或取消尝试仍计入，它们同样消耗了上游用量；零用量尝试不计。

## 2. 把同一份规则放到本机

把远端配置复制到本机 `~/.config/magpie-tokensci/config.json`。
两端的 `from`、`timezone`、模型、agent、调用方范围必须一致。
本机不读取远端的 `gateway.logs`，保留其远端路径即可。

`local.legacyPi: true` 用于从 tokens 27.0.1 升级：它过去把 OMP 上报为 `pi`，
新扫描器的 OMP 输出继续映射到 `pi`，避免历史按两个客户端重复存在。
若此前已一直用新版并上报为 `omp`，在首次运行前设为 `false`。

本机的 tokens 时区必须与规则一致。第一次预览也会固定统计分区，之后不能直接
改动 `from`、模型、调用方或客户端归属；改统计范围需要计划迁移，不要删除状态绕过。

## 3. 两端预览，停掉本机旧提交服务

本机：

```sh
magpie-tokensci local --dry-run > local-preview.json
```

远端：

```sh
magpie-tokensci gateway --dry-run > gateway-preview.json
```

标准输出是完整待提交 JSON；过滤数量和日志收集数量输出到 stderr。
切换日期之前，本机照常保留别名记录，远端不收集它们；网关尚无匹配记录时预览为 `null`。
未来的切换日期尚未到时，暂时没有网关记录是正常的。

确认后，**本机停止旧的全量提交服务**，否则它会继续把已排除记录上传：

```sh
brew services stop owo-network/brew/tokens
```

若启用过 `tokens autosubmit`，还需执行 `tokens autosubmit disable`。
普通 `tokens submit` 也不会应用本包过滤；切换后统一用下面的命令。

## 4. 启动提交

本机运行：

```sh
magpie-tokensci local
magpie-tokensci serve local
```

`serve` 是前台长期进程，每 `intervalMinutes` 分钟提交一次；交给系统服务管理器
保持运行。以下是本机 macOS 的 LaunchAgent 示例。先用 `command -v magpie-tokensci`
找到实际路径，替换 `ProgramArguments` 中的路径和用户名。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.magpie-tokensci</string>
  <key>ProgramArguments</key><array>
    <string>/实际路径/magpie-tokensci</string><string>serve</string><string>local</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/实际的node目录:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>/Users/你的用户名</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/你的用户名/Library/Logs/magpie-tokensci.log</string>
  <key>StandardErrorPath</key><string>/Users/你的用户名/Library/Logs/magpie-tokensci-error.log</string>
</dict></plist>
```

保存为 `~/Library/LaunchAgents/local.magpie-tokensci.plist` 后：

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.magpie-tokensci.plist
```

远端可独立运行：

```sh
magpie-tokensci gateway
magpie-tokensci serve gateway
```

也可由 Magpie 插件宿主后台运行。将远端配置的 `gateway.enabled` 改为 `true`，然后：

```sh
magpie plugin add galentwww/magpie-tokensci
```

已安装 0.1.0 的先执行 `magpie plugin update`。修改配置后对本插件 off/on 重载。
插件与 `serve gateway` 选一种；安装本身不会启用上传，默认 `enabled: false`。
插件只在 Magpie 宿主运行期间工作；定时提交不需要等待新的模型请求。

## 已经上报过的日期如何迁移

推荐从明天开始，不改历史。若确实要从今天或更早开始，必须在首次预览前就把
两端 `from` 设为同一天，并确认网关日志覆盖该日期以来的调用。

Tokens 会保留同设备、同客户端较大的旧统计；只过滤再提交无法自动降低它。
本机提供一次性、明确日期范围的替换命令：

```sh
magpie-tokensci local --replace --since 2026-11-17 --until 2026-11-17 --dry-run > migration.json
# 检查全部待保留的本机用量后，再真正提交：
magpie-tokensci local --replace --since 2026-11-17 --until 2026-11-17
```

这使用 tokens 官方 `clientManifest.coverage` 协议，替换受影响客户端在指定日期范围
内的统计；其他客户端不带替换声明。一个客户端的其他模型会随完整保留数据一起提交，
即使该客户端全部被排除，也发送明确的零用量替换行。
**替换前需要本机该客户端在日期范围内的完整原始数据**：若旧会话文件已清理，
替换也会丢掉本来应保留的历史。这不是仅按模型删除的服务端 API。
完成本机历史替换后，再从网关补报同一期间；不能同时保留本机旧统计和远端补报。

## 数据与恢复

- 默认状态在配置旁的 `state/`，可用 `stateDir` 指定绝对路径。请备份整个目录。
- 网关 journal 持久保存已经读到的用量；tokens 的扫描 HOME 完全隔离，不读取远端其他
  agent 会话。journal 和导出记录不含提示词、回复正文、账号邮箱或 API key。
- 完整日志行按内容哈希去重，`response_id` 重用不会吞掉不同调用；实际失败重试的用量
  各自计入。同一日志重放不会重复累加，网络失败后重提同设备的累计快照。
- 半写日志行等待下一轮；完整坏行会报错。程序自己的 journal 中断尾行会恢复。
- 已收集记录在源日志轮转后仍保留；首次采集前已丢失的日志无法恢复。可在 `logs`
  追加仍保留的归档日志路径，路径必须可读取。
- 不要删网关的 `state/gateway/tokens/device.json` 或把同一份本机记录交给多个网关设备。
- 后台和手工命令共享进程锁；每轮完成才安排下一轮。上传成功后保存 `last-submit.json`。
- `TOKENS_API_URL` 可指向测试服务；正式提交要求 HTTPS，仅 loopback 测试允许 HTTP。
- 安装本身不会登录、停止旧服务、修改 agent 配置、改动原始会话、修正历史或上传。
  核对预览后，由操作者显式运行提交命令或启用网关后台服务。

## 验证

```sh
npm ci --ignore-scripts
npm test
```

测试调用真实 tokens 27.2.1 扫描和计价，并向本地 HTTP 接收器验证提交失败与重试。
覆盖精确过滤、日期/时区边界、调用方隔离、重复 ID、日志轮转与半写恢复、独立设备身份、
旧版 Pi 归属和零用量历史替换。测试不会向 tokens.ci 提交。
