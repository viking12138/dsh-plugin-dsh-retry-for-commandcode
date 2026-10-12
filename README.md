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

每一轮把所有策略走一遍；走完还没解决就进入下一轮（默认 3 轮），策略重新可用。
`failover` 走过的路由会被记住，不会重复撞同一个坏路由。

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
| `backoff` | object | `{initialDelayMs:500, maxDelayMs:30000, jitterRatio:0.2}` | 有界指数退避 + 对称抖动 |
| `probeAttempts` | int | `1` | 原样重试次数（每轮） |
| `failover.enabled` | bool | `true` | |
| `failover.mode` | `same-model`\|`any` | `same-model` | `same-model`：只换 provider，**保留你选的模型** |
| `failover.autoDiscover` | bool | `true` | 从 `ctx.llm.listProviders()` / `listModels()` 里找候选 |
| `failover.models` | {provider,model}[] | `[]` | 显式候选，排在最前 |
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
`AUTH` / `QUOTA` / `ACCOUNT_QUOTA` / `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` / `ABORTED`
被显式排除，交给官方策略处理。

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
retry-for-commandcode:   previous-step: assistant#180 of 187 messages, 2 tool call(s), 92310 result chars
retry-for-commandcode:     called read (args 41 chars)
retry-for-commandcode:     called pwsh (args 88 chars)
retry-for-commandcode:     result 91200 chars "…"
retry-for-commandcode:   suspected-causes:
retry-for-commandcode:     [medium] 3 surface node(s) exceed 8192 chars (largest: seq 42 tool/result at 91200 chars)
retry-for-commandcode:         remedy: prune trims oversized text to a head/tail window
```

`previous-step:` 就是「上一步做了什么」：最近一条 assistant 消息调用了哪些工具（带参数长度），
以及每个调用返回了多大的结果。`suspected-causes` 是按可能性排序的推测 + 对应 remedy。

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
npm test              # 36 项：分类、配置校验、内容变换、策略梯子、事件接线
npm run test:integration   # 9 项：对真实 dsh-session 的写入/重放/恢复
npm run test:all
```

自测用迷你 session 跑纯逻辑；集成测试加载**真实的 `@deepseek-ai/dsh-session`**
（自动在 `$DSH_HOME` / `~/.dsh` / dsh 安装目录里找，找不到就跳过），验证四件只有对着真实现才能验证的事：

1. `Session.append` 接受这条写入；
2. 推导出的请求历史**真的变小**；
3. `foldSurface` 重放出的消息与实时视图**逐字节一致**；
4. 重建会话（也就是「恢复」）后仍然**完全一致** —— 这正是不能自造事件类型的原因。

---

## 9. 结构

```
lib/index.js        插件入口：name / inject / apply，监听器接线与恢复预算
lib/classify.js     失败判定（provider + code + 报文措辞），状态回读，供应商错误字段抽取
lib/diagnose.js     诊断构建与渲染（「上一步做了什么」、推测原因 + remedy）
lib/surface.js      surface 检视 + 可重放的持久化内容修复（prune / elide / rewriteNodeContent）
lib/strategies.js   六个策略 + 梯子编排 + 用户选择后的定向执行
lib/config.js       同步严格校验与默认值（手写，不依赖 schemastery）
test/               self-test 与真实 session 集成测试
cordis.patch.yml    bundle 层：挂载插件行
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
- **`failover` 会持久改变路由**（见第 4 节）。
- **整个类都被接管**：`INVALID_REQUEST` 也包含重试救不了的那种（比如工具参数 schema 错误）。
  这类情况下梯子会走完、预算会耗尽，最终按 `onExhausted` 决定是问用户还是照常报错。
