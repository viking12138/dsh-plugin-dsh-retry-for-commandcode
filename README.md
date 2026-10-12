# dsh-retry-for-commandcode

让 DSH 任务在 `commandcode`（`openai-responses`）路由返回 **HTTP 400
`invalid_request_error`** 时**不中断**：诊断原因、自动选择修复策略、改动可持久化的会话历史，
然后让当前步骤重试。

```
hh-commandcode2 API error (400): {"message":"{\"type\":\"invalid_request_error\",\"code\":\"\",
\"message\":\"invalid request error trace_id: 53cfc3ba...\"}\n","type":"invalid_request_error"}
```

---

## 1. 为什么任务会直接断开

这不是「重试次数不够」，而是**没有任何一层会接管这个错误**：

| 环节 | 事实 | 结论 |
|---|---|---|
| 错误分类 | `dsh-llm-pi-ai` 的 `classifyPiAiError` 遇到 `400 / invalid.?request` 归类为 `INVALID_REQUEST` | 错误代码是 `INVALID_REQUEST` |
| 默认重试集合 | `dsh-llm-retry` 的默认 `retryableCodes` 只有 `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT` | **`INVALID_REQUEST` 不在里面** |
| 你的 profile 配置 | `hh-commandcode` / `hh-commandcode2` 都没有配 `retryPolicy` | 走默认集合 → 不重试 |
| 结果 | `agent/request-error` 瀑布流所有监听器都 `next()` 委托 | 步骤终止 → 任务中断 |

所以本插件做的事很单纯：**注册第二个 `agent/request-error` 监听器**，接管这一类失败。

---

## 2. 它怎么工作

DSH 的 agent loop 每一轮尝试都会重新从**会话日志**推导请求
（`buildRequest` → `session.deriveMessages()`），而已经组装好的请求对象是深度冻结的。
所以插件**不能改请求**，只能**改历史**，然后让重试自己重新推导 —— 这正是
`dsh-compaction-image-offload` 和 `dsh-compaction-tool-result-pruner` 的做法。

```
agent/request-error 触发
        │
        ├─ ① 判定：provider + code + 报文措辞 三者同时命中才接管
        │
        ├─ ② 诊断：供应商错误类型/代码/trace_id、历史规模、上一步调用了哪些工具、结果多大
        │
        ├─ ③ 策略梯子（从最轻到最重，逐级升级）
        │
        └─ ④ return { kind: 'retry' }   ← 这是瀑布流唯一可用的恢复动作
```

### 策略梯子

| # | 策略 | 做什么 | 代价 |
|---|---|---|---|
| 1 | `probe` | 原样重试一次（带退避） | 一次请求，不改任何东西 |
| 2 | `failover` | **下一次尝试换一条路由**（默认：同模型、换 provider） | 不改历史，零上下文损失 |
| 3 | `prune` | 把超长文本裁成 head + 标记 + tail | 丢掉中段 |
| 4 | `elide` | 把最旧的节点内容替换成短 head + 移除提示 | 丢掉旧上下文 |
| 5 | `compact` | 调用官方压缩引擎（`context-overflow` 触发器）做真摘要 | 一次额外模型调用 |
| 6 | `ask` | 弹出诊断 + 选项让用户选 | 等人 |

**升级规则**：一个策略只要取得了进展（无论改历史还是换路由），它就被**记为已用**，
所以下一次失败会**往前走一格**，而不是重跑同一个策略。连续失败时的实际序列就是梯子本身的顺序：

```
probe → failover → prune → elide → compact → ask
```

一轮走完还没解决就进入下一轮（默认 3 轮），策略重新可用。
`failover` 走过的路由会被记住，不会重复撞同一个坏路由。

> 这条规则是**从一个真实会话里修出来的**：原先「成功的策略不记已用」，而 `failover` 总能找到
> 下一条路由、永远声称有进展，于是在同一个 step 上连撞 4 次全部走 failover，
> `prune` / `elide` / `compact` **一次都没跑过**。修复后，请求修复在第 2 次失败就会被尝试。
> 完整证据见第 11 节。

### 关于「清空上下文」的诚实说明

DSH **没有**中途「清空上下文」的 API，这不是本插件偷懒：

- session 日志是 append-only，surface 只有一种结构性操作 `replace`；
- `replace` 的边界必须**工具调用配对平衡**，否则会切断一个还开着的 step，`dsh-session` 会直接拒绝；
- 面向用户的 `/compact` 走 `CompactionEngine.compactNow`，它要求 agent **idle**，在活跃 turn 里调用会抛 `busy`；
- `SessionStartSource` 的 `'clear'` / `'compact'` **保留但还没有任何发送方**。

因此本插件用 `elide` 表达「清空」：把最旧节点的**内容**换掉，但**保持节点拓扑、工具配对、
消息标识、重放重建完全不变**。对一次编码会话来说，上下文的大头就是工具输出，`elide` 能去掉绝大部分，
而结构一点没动。需要真正的语义压缩时用 `compact`（官方引擎）。

### 子智能体（子 agent）

`agent/request-error` 是 scope-filtered 派发，而挂在 profile 根上下文上的监听器是 **untagged** 的，
会被**所有** agent 命中 —— 包括同进程的 `spawn` / `fork` 子智能体。插件按 `payload.agent` 分别记账，
并通过 `agent.ctx` 优先解析服务（agent preset 的 `compaction` / `toolResultPruner` 在隔离的 preset
作用域里，不在 profile 根）。`ask` 对子智能体会主动放弃 —— 子智能体没有人类应答者。</br>
（进程外的子运行时不在这条总线上：ACP / SDK / Codex / Claude Code。）

---

## 3. 安装

```powershell
# 1) 以软链接方式装进 web profile（改完代码，重新 import 就能生效）
dsh plugin --profile web add "link:D:\code\github\dsh-retry-for-commandcode"
```

本包声明了 `dsh.bundle.patch`，所以 `dsh plugin add` 会把它自动追加进
`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`，并由它自带的
`cordis.patch.yml` 挂载插件行。**装完确认一下**（见第 7 节的核对命令）：
`retry-for-commandcode` 只应出现一次 —— 不要再手工往 profile 的 `cordis.patch.yml`
里加一条同样的 `insert`，否则会重复挂载。

**装完重启 `dsh web`。** `dsh-hmr` 在这个 profile 里是开着的，但 `root: []` 意味着
**只热重载配置，不监视源码**；新增的包依赖靠重启最稳。

如果自动追加 bundles 没发生，手工把包名加进 profile 的 `dsh.profile.bundles` 即可：

```json
"dsh": { "profile": { "bundles": [ "...", "dsh-retry-for-commandcode" ], "patchReload": "live" } }
```

卸载：

```powershell
dsh plugin --profile web remove dsh-retry-for-commandcode
```

---

## 4. 配置

在 profile 的 `cordis.patch.yml` 里按 row id 覆盖：

```yaml
- id: retry-for-commandcode
  name: dsh-retry-for-commandcode
  config:
    dryRun: false
    failover:
      enabled: true
      mode: same-model
      models:
        - provider: command
          model: deepseek/deepseek-v4.1-flash
    elide:
      keepRecentNodes: 20
```

配置在加载时**同步严格校验**，写错键名会以精确路径报错（例如
`retry-for-commandcode: unknown option "prune.nope"`），而不是被静默忽略。校验失败会让插件不挂载，
日志里能看到原因。

### 完整选项

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | bool | `true` | 关掉后不注册任何监听器 |
| `dryRun` | bool | `false` | 只诊断 + 打日志，不改历史、不接管（用来先观察真实触发频率） |
| `providers` | string[] | `[]` | 只接管这些路由；`[]` = 全部；支持结尾 `*` 通配（`hh-commandcode*`） |
| `codes` | string[] | `["INVALID_REQUEST"]` | 接管的 `LlmFailure.code` |
| `statuses` | int[] | `[400, 413]` | 接管的 HTTP 状态。**注意**：pi-ai 适配器构造的 `LlmFailure` 只有 `{message, code}`，`status` 是 `undefined`，所以这一项通常不生效 —— 状态是从报文里回读的，见 `messagePatterns` |
| `messagePatterns` | string[] | 见下 | 正则**源串**，与报文做不区分大小写匹配；三者（provider/code/措辞）同时命中才接管 |
| `strategies` | string[] | `["probe","failover","prune","elide","compact","ask"]` | 梯子顺序，可删可调 |
| `maxRecoveriesPerStep` | int | `50` | 单步恢复次数硬上限 |
| `maxCycles` | int | `3` | 梯子循环轮数 |
| `onExhausted` | `ask`\|`delegate`\|`retry` | `ask` | 梯子走完后：问用户 / 交还给 DSH 报错 / 无限保活 |
| `onExhaustedFallback` | `delegate`\|`retry` | `retry` | `ask` 拿不到决定时的兜底 |
| `onQuota` | `failover`\|`delegate` | `failover` | 额度/余额类失败（`code = QUOTA`）怎么办。中继/网关路由的「余额不足」只影响**那一个 key**，换路由就能继续，所以默认接管；`ACCOUNT_QUOTA`（账号级计费）永远不接管 |
| `backoff` | object | `{initialDelayMs:500, maxDelayMs:30000, jitterRatio:0.2}` | 有界指数退避 + 对称抖动 |
| `probeAttempts` | int | `1` | 原样重试次数（每轮） |
| `failover.enabled` | bool | `true` | |
| `failover.mode` | `same-model`\|`any` | `same-model` | `same-model`：只换 provider，**保留你选的模型**；`any`：允许换模型（这是唯一能真正换到**不同上游**的模式，见第 11 节） |
| `failover.autoDiscover` | bool | `true` | 从 `ctx.llm.listProviders()` / `listModels()` 里找候选 |
| `failover.models` | {provider,model}[] | `[]` | 显式候选，排在最前 |
| `failover.exclude` | string[] | `[]` | 永不使用的路由（例如已知余额为 0、或与失败路由是**同一上游别名**的那些） |
| `failover.maxTargets` | int | `4` | 候选上限 |
| `prune.thresholdChars` | int | `8192` | 超过才裁 |
| `prune.headChars` / `tailChars` | int | `2048` / `1024` | 保留的头/尾长度 |
| `prune.maxNodes` | int | `60` | 单次最多改几个节点 |
| `prune.includeUserMessages` | bool | `false` | 是否也裁用户消息（默认只裁工具结果） |
| `elide.keepRecentNodes` | int | `14` | 最近的 N 个节点永不精简 |
| `elide.minChars` | int | `400` | 小于此长度的节点跳过 |
| `elide.headChars` | int | `240` | 每个节点保留的头部 |
| `elide.maxNodes` | int | `80` | 单次最多精简几个节点 |
| `elide.minTotalChars` | int | `6000` | 历史总量低于此值就不精简 |
| `elide.includeUserMessages` | bool | `false` | 是否也精简用户消息 |
| `compact.enabled` | bool | `true` | |
| `ask.enabled` | bool | `true` | |
| `ask.timeoutMs` | int | `600000` | 等用户回答的上限 |
| `logDiagnostics` | bool | `true` | 打诊断日志 |

默认 `messagePatterns`：

```yaml
- 'API error \(4(?:00|13)\)'
- 'invalid[_ ]?request'
- 'payload too large'
- 'request body too large'
- 'length limit exceeded'
```

### 关于 `failover` 会「粘住」

被切换后的调用配置会被 loop 记成新的 `request/header`，所以一旦切换成功，
**后续步骤会继续用新路由**，而不是只影响这一次尝试。这是有意的（任务能跑下去），
但它是持久的模型/供应商变更 —— 不想要的话就 `failover.enabled: false`，
或者把 `strategies` 里的 `failover` 去掉。

---

## 5. 永远不会「更糟」

插件里所有路径都包在 try/catch 里，**任何自身异常都会委托给下一个监听器**，
也就是「没有这个插件时会发生的行为」。它不可能成为 turn 失败的原因。
`AUTH` / `ACCOUNT_QUOTA` / `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` / `ABORTED` /
`UNSUPPORTED_REASONING_EFFORT` / `UNKNOWN_MODEL` / `NO_ADAPTER` / `INVALID_CONFIG`
被显式排除，交给官方策略处理。

`QUOTA`（路由级余额不足）**不在**排除列表里：中继/网关的「余额不足」只影响那一个 key，
换路由就能继续，所以默认由 `onQuota: 'failover'` 接管；账号级的 `ACCOUNT_QUOTA` 仍然永不接管。
但如果所有路由都不可用，它会立刻把错误交出去（见第 4 节），不会退避重试同一个没余额的 key。

**代价**：每次恢复都可能是一次额外计费的模型请求。用 `maxRecoveriesPerStep`
和 `backoff.maxDelayMs` 控制；想完全不冒险就先开 `dryRun: true` 观察一段时间。

---

## 6. 观测

诊断打到 DSH 进程日志（`warn` 级别），前缀 `retry-for-commandcode:`：

```
retry-for-commandcode: provider=hh-commandcode2 model=deepseek/deepseek-v4.1-flash code=INVALID_REQUEST status=400 turn=3 step=2 attempt=1/1
retry-for-commandcode:   provider-error: type=invalid_request_error trace_id=53cfc3ba738d8e7749918f27a2653fa8
retry-for-commandcode:   provider-message: "invalid request error trace_id: 53cfc3ba..."
retry-for-commandcode:   matched-because: provider+code+message agree
retry-for-commandcode:   history: 187 surface nodes, 412038 chars (~103010 tokens)
retry-for-commandcode:     largest seq=42 tool/result chars=91200 [textx1] "…"
retry-for-commandcode:   request: 187 messages, 1.4 MB (~368011 tokens), untouchable 68% (975 KB)
retry-for-commandcode:     role assistant: 812 KB
retry-for-commandcode:     role tool: 498 KB
retry-for-commandcode:     role user: 121 KB
retry-for-commandcode:     block assistant:reasoning: 402 KB
retry-for-commandcode:     block assistant:tool-call: 388 KB
retry-for-commandcode:     block tool:text: 498 KB
retry-for-commandcode:     largest message: 91.1 KB role=tool id=t-42 [text]
retry-for-commandcode:   previous-step: assistant#180 of 187 messages, 2 tool call(s), 92310 result chars
retry-for-commandcode:     called read (args 41 chars)
retry-for-commandcode:     called pwsh (args 88 chars)
retry-for-commandcode:     result 91200 chars "…"
retry-for-commandcode:   suspected-causes:
retry-for-commandcode:     [high] 68% of the outgoing request (975.0 KB of 1.4 MB, ~368011 tokens) is inside assistant messages, which this plugin is structurally unable to rewrite
retry-for-commandcode:         remedy: prune/elide only reach tool results and user messages; shedding the assistant span needs compact (or a lower compaction trigger)
retry-for-commandcode:     [medium] 3 surface node(s) exceed 8192 chars (largest: seq 42 tool/result at 91200 chars)
retry-for-commandcode:         remedy: prune trims oversized text to a head/tail window
```

`previous-step:` 就是「上一步做了什么」：最近一条 assistant 消息调用了哪些工具（带参数长度），
以及每个调用返回了多大的结果。`suspected-causes` 是按可能性排序的推测 + 对应 remedy。

`request:` 是**请求组成实测**（`describeRequestComposition`）：把即将发出的消息按 JSON 字节
拆成角色与块类型，并算出其中有多少是插件**结构性动不了**的。`untouchable` 就是那部分 ——
它全部位于 assistant 消息里（见第 10 节）。这条实测存在的理由很直接：一个真实会话里插件把
tool 文本从 432 KB 压到 136 KB，请求却仍然超过 1 MB 被拒；不做这个测量，插件看起来就像什么都没干。

**不往会话日志里写自定义事件** —— 这是刻意的。`session.append` 无法设置 `ignorable`
信封标记，而 `dsh-session-persistence` 遇到不在 `KNOWN_SESSION_EVENT_TYPES` 里、
又没有 `ignorable` 的事件类型会**拒绝恢复整个会话**。所以插件只写 harness 已知的类型：
`compaction/prune` 加一个同类型的单节点替换。

---

## 7. 核对安装

```powershell
# 插件行恰好出现一次（注意 Config dump 里会同时出现 bundle 层和 profile 修补层）
dsh --profile web --dump-config | Select-String -Pattern 'retry-for-commandcode'

# bundles 里是否已登记
Get-Content "$env:USERPROFILE\.dsh\profiles\web\package.json" -Raw

# 载入是否报错（真实 import，不是静态检查）
node -e "import('dsh-retry-for-commandcode').then(m => console.log(m.name, m.inject))" `
  --input-type=module
```

---

## 8. 测试

```powershell
npm test              # 46 项：分类、配置校验、内容变换、请求组成、策略梯子、事件接线
npm run test:integration   # 12 项：对真实 dsh-session 的写入/重放/恢复/组成测量
npm run test:all
```

自测用迷你 session 跑纯逻辑；集成测试加载**真实的 `@deepseek-ai/dsh-session`**
（自动在 `$DSH_HOME` / `~/.dsh` / dsh 安装目录里找，找不到就跳过），验证只有对着真实现才能验证的事：

1. `Session.append` 接受这条写入；
2. 推导出的请求历史**真的变小**；
3. `foldSurface` 重放出的消息与实时视图**逐字节一致**；
4. 重建会话（也就是「恢复」）后仍然**完全一致** —— 这正是不能自造事件类型的原因；
5. 请求组成测量把字节**恰好分类一次**（`touchable + untouchable = total`）；
6. 真实 `Session` 拒绝替换 `assistant/message`：带 `sourceEventSeqs` 会被
   `assertSourceEventReferences` 拒绝，不带又缺少必需引用 —— 两条路都堵死，
   这就是「assistant 字节不可动」的机器证明（集成测试里构造的 assistant 消息带
   `source.replayState` 与已结算的 `stream`，与真实日志同形）。

---

## 9. 结构

```
lib/index.js        插件入口：name / inject / apply，监听器接线与恢复预算
lib/classify.js     失败判定（provider + code + 报文措辞），状态回读，供应商错误字段抽取
lib/diagnose.js     诊断构建与渲染（「上一步做了什么」、请求组成、推测原因 + remedy）
lib/surface.js      surface 检视 + 可重放的持久化内容修复（prune / elide / rewriteNodeContent）
                    + describeRequestComposition：请求组成的字节实测与「动不了」的占比
lib/strategies.js   六个策略 + 梯子编排 + 用户选择后的定向执行
lib/config.js       同步严格校验与默认值（手写，不依赖 schemastery）
test/selftest.mjs             迷你 session 上的纯逻辑自测
test/integration-realsession.mjs  对真实 dsh-session 的写入/重放/恢复/组成测量
cordis.patch.yml    bundle 层：挂载插件行
preset-standard.early-compaction.yml
                    profile 层的 preset 覆盖（1M 路由更早压缩）。**不是** bundle 的一部分，
                    只是把部署到 ~/.dsh/profiles/web/cordis.patch.yml 的那一块留档，两边
                    需逐字一致；DSH 升级改动 standard preset 后要重新生成
```

**零 `@deepseek-ai/*` 运行时依赖**，所以有没有 peer 版本校验都一样能加载，
也不依赖 profile 的模块解析拦截。

---

## 10. 已知边界

- **没有中途真正的「清空」**：原因见第 2 节。`elide` 是内容级清空，`compact` 是官方结构性摘要。
  `/compact`（`compactNow`）要求 agent idle，活跃 turn 里用不了。
- **进程外子运行时不在覆盖范围**：ACP / SDK / Codex / Claude Code 的子进程有自己的运行时和事件总线。
- **`statuses` 对 pi-ai 路由基本是死选项**：`LlmFailure.status` 是 `undefined`，
  状态从报文里回读。自定义 provider 适配器如果填了 `status`，这一项就会生效。
- **`prune` / `elide` 只动 `text` 块**：`reasoning`、`image`、`file`、工具变更块原样保留 ——
  改它们有让 provider 拒绝重放状态的风险，图片是 `dsh-compaction-image-offload` 的职责。
- **assistant 消息整体不可重写（结构性上限）**：`dsh-session` 的
  `assertSourceEventReferences` 要求 surface 替换必须引用被遮蔽节点的 `sourceEventSeqs`，
  而 `assistant/message` **禁止**携带该字段（它自己就带着 provider 重放状态 `source.replayState`
  与已结算的 `stream`，改内容会让路由无法继续）。所以 `assistant/message` 里的
  `reasoning` 与 `tool-call` 载荷（长会话里增长最快的那部分）**永远不能靠内容级重写裁掉**，
  只有 `compact` 能通过「用一个摘要节点替换一段平衡区间」把它摘掉。
  这正是第 6 节 `request:` 那行 `untouchable` 的含义，也是为什么这个工作负载建议把
  `prune.thresholdChars` 调小、并把 `compact` 排在 `failover` 之前。
- **`failover` 会持久改变路由**（见第 4 节）。
- **整个类都被接管**：`INVALID_REQUEST` 也包含重试救不了的那种（比如工具参数 schema 错误）。
  这类情况下梯子会走完、预算会耗尽，最终按 `onExhausted` 决定是问用户还是照常报错。

---

## 11. 真实会话复盘（katynAndVerdin，2026-10-12）

装完插件后的一次真实运行，最后报的是「本轮运行失败当前请求的额度已用尽」。
解码该会话的持久化日志（`~/.dsh/sessions/--D-code-github-katynAndVerdin--/session-daa9ae74-…/session.v4.jsonl.zstd`）
后，turn 7 step 6 的完整序列是：

| # | 事件 | 供应商 | 结果 |
|---|---|---|---|
| 1 | `assistant/attempt` | `hh-commandcode2` | 400 `INVALID_REQUEST`（trace `c9c59b56…`） |
| 2 | `assistant/attempt` | `hh-commandcode2` | 400 `INVALID_REQUEST`（trace `92e6d128…`） ← 未改动的重试 = `probe` |
| 3 | `request/header` | → **`command`** | 插件 `failover` 第 1 次 |
| 4 | `assistant/attempt` | `command` | 400 `INVALID_REQUEST`（trace `e6ce54ab…`） |
| 5 | `request/header` | → **`hh-commandcode`** | 插件 `failover` 第 2 次 |
| 6 | `assistant/attempt` | `hh-commandcode` | **`QUOTA`**：`You have insufficient credits to make this request.` |
| 7 | `step/end` → `turn/end` | | 任务结束 |

判定插件确实参与的证据：`llm/retry` 事件数为 **0**（这些重试不是 `dsh-llm-retry` 发出的），
而 `request/header` 里 provider 连续三次变化 —— 正是 `agent/request` 覆盖产生的签名。

**这次运行暴露了三个问题，都已修：**

1. **梯子被 `failover` 饿死。** 成功的策略没有记为已用，而 `failover` 永远能找到下一条路由、
   永远声称有进展，于是一个 step 连撞 4 次全走 failover，`prune` / `elide` / `compact`
   **一次都没跑过**。这个会话的请求明显偏大（turn 7 step 5 有一条 103,964 字节的
   assistant 消息和一个 23,476 字节的 tool call），请求修复才是最可能有效的策略。
   → 现在成功的策略会被记为已用，第二次失败就会尝试 `prune`。

2. **`command` / `hh-commandcode` / `hh-commandcode2` 是同一个上游的三个 key。**
   三者 `baseURL` 都是 `https://api.commandcode.ai/provider/v1`。
   在 `LlmProviderInfo` 里只有 `{id, name}`，**插件无法从服务 API 看出它们是别名**，
   所以默认的 `same-model` 模式只找得到这些别名，换过去当然还是同样的 400。
   → 新增 `failover.exclude`，并且当「只有别的模型的候选存在」时打日志说明
   `mode: 'any'` 才能换到真正不同的上游（例如已挂载的 `dsh-llm-deepseek` / `deepseek-flash`）。

3. **路由级「余额不足」被当成终局。** `hh-commandcode` 返回的是 HTTP 400 +
   `insufficient credits`，分类器先匹配 `isQuotaExceededError`，得到 `QUOTA`。
   原实现把 `QUOTA` 整体列为不接管 → 直接委托 → 任务结束，用户就看到了那句额度提示。
   → 新增 `onQuota`（默认 `failover`）：中继路由的「余额不足」只影响那一个 key，
   换到还有余额的路由就能继续；账号级的 `ACCOUNT_QUOTA` 仍然永不接管。
   而且当**没有别的路由可换**时，它会直接把错误交出去，而不是退避重试那个没余额的 key
   —— 重试同一个 key 不可能把余额重试出来。

> 注：另外 6 次 400（turn 1/3/4/5/6）发生在插件安装之前，那时每次都是直接中断，
> 用户靠手动发新消息继续。其中 turn 5 的 trace `53cfc3ba738d8e7749918f27a2653fa8`
> 正是最初报告的那一条。

**这个环境实际部署的配置**（三个别名共用一个上游，且其中一个已知余额为 0）：
先修请求、最后才换路由；`same-model` 是刻意的保守选择 —— 宁可不救，也不让任务中途换模型。

```yaml
- id: retry-for-commandcode
  name: dsh-retry-for-commandcode
  config:
    failover:
      mode: same-model                             # 只在同一模型 id 的路由间跳（不换模型）
      exclude: [hh-commandcode]                    # 已知余额为 0 的别名
    prune:
      thresholdChars: 4096                         # 这个会话上下文很大，更早动手
    strategies: [probe, prune, elide, compact, failover, ask]   # 先修请求，再换路由
```

如果修完请求**仍然**反复吃同一个 400（第 12 节那种体积型拒绝），再把 `mode` 改成 `any`
以允许换到另一个上游（例如已挂载的 `dsh-llm-deepseek` / `deepseek-flash`）。
两者的差别就是**是否允许换模型**：`same-model` 只找得到同模型的路由，在这个环境里就是
三个别名之间互跳，救不了请求形状/体积导致的 400。

---

## 12. 第二个真实会话复盘（本仓库，2026-10-12）：结构性上限

装好插件后**仍然**遇到 400（trace `d1a40d835d557a200031ab68b1a7a488`），所以又解码了本仓库
自己的会话日志（`~/.dsh/sessions/--D-code-github-dsh-retry-for-commandcode--/session-c3691af0-…`）。
这份日志给出的关键数字是：

| 事件类型 | 次数 |
|---|---|
| `compaction/prune` | **90** |
| `compaction/start` | **0** |
| `compaction/summary` | **0** |

也就是说：`prune` 一直在跑（90 次），而 `compact` 一次都没有真正启动过。第 6 节的
`request:` 实测就是为了解释这件事：**请求的大头不在插件能改的地方。**

1. **assistant 节点的字节不可动。** `prune` / `elide` 只能重写 `tool/result` 与
   `user/message`。长会话里增长最快的 `assistant/message`（`reasoning` + `tool-call`，
   还带着 provider 重放状态）属于 `assistant/message`，而它**禁止**携带
   `sourceEventSeqs`，因此永远不能作为 surface 替换的目标。所以「把 tool 输出从
   432 KB 压到 136 KB，请求仍超过 1 MB 被拒」不是插件偷懒，是结构决定的。
   → `guessCauses` 现在会在「不可动占比 ≥ 50% 且其字节数超过 `prune.thresholdChars`」时
   把这一条列为最高优先级的推测（≥70% 记为 `high`），remedy 直指 `compact`；
   `renderDiagnosis` 同时渲染 `request:` 组成行，让「压了多少 / 还剩多少 / 其中多少动不了」
   一眼可见。两条都有自测与真实 session 集成测试覆盖。

2. **`compact` 是唯一能摘掉 assistant 载荷的档位。** 它通过「用一个摘要节点替换一段
   平衡区间」来改变面，而不是重写单节点内容。这解释了为什么这个工作负载的梯子必须把
   `compact` 排在 `failover` 之前，也解释了为什么建议把 `prune.thresholdChars` 调小
   （更早动手、别等请求长到 1 MB 才压）。
   → 另外还部署了 `preset-standard` 的早压缩参数（`thresholdRatio: 0.06`、
   `retainTokens: 20000`），让官方 compaction 在 1M 上下文的路由上更早介入。

**仍然开放的问题**：这份日志里 `compact` 为什么一次都没启动（是没走到那一档、还是走到了
但引擎判定「没有可安全压缩的区间」），需要在下一次真实运行的日志里看 `retry-for-commandcode:`
的 `compact` 相关行才能确认。
