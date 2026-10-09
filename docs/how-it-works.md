# 机制原理：provider 注入、选模型规则、多轮、缓存

本文解释 `dsh-zcode-coding-plan` 到底做了什么。全部结论来自 Windows + ZCode 3.14.5 的实测。

---

## 一、整体调用链

```
DSH 桌面端 agent
  │  ctx.tools.register(zcode_call)
  ▼
zcode_call.execute(args, exec)
  │
  ├─ 1. 校验 prompt / 解析 cwd
  ├─ 2. 余量闸门（可选，不足则快速拒绝）
  ├─ 3. 探测 ZCode 可执行 + zcode.cjs
  └─ 4. spawn 子进程
        │
        │  argv: [<zcode.cjs>, --mode, <mode>, --json, (-p, <prompt> | --resume, <sid>), ...]
        │  env:  ELECTRON_RUN_AS_NODE=1
        │        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=<我们的覆盖配置>
        │        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=<ZCode 内置 provider 配置>
        ▼
      ZCode.exe（以 node 模式运行）
        │
        ├─ 读 provider 配置 → 选 provider → 选 model
        ├─ 走 anthropic-messages 端点调 open.bigmodel.cn
        └─ 在 stdout 输出一个 JSON 对象
        ▼
      插件解析 stdout → { sessionId, response, usage, projection }
```

### 两个环境变量是关键

| 变量 | 作用 |
| --- | --- |
| `ELECTRON_RUN_AS_NODE=1` | 让 Electron 可执行文件以纯 Node 模式启动，于是能直接跑 `.cjs` 入口 |
| `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` | 指向**我们生成的覆盖配置**——模型选择的战场就在这里 |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 指向 ZCode 自带的 provider 配置（内置 provider 定义） |

### stdout 的形态

CLI 会在 stdout 输出**恰好一个** JSON 对象：

```json
{
  "sessionId": "sess_…",
  "traceId": "…",
  "turnId": "…",
  "response": "…",
  "usage": { "source": "provider", "modelRequestCount": 1,
             "inputTokens": 67512, "outputTokens": 4, "totalTokens": 67516,
             "cacheReadTokens": 13504, "cacheWriteTokens": 0 },
  "projection": { "status": "idle", "turnCount": 1,
                  "contextUsed": 67516, "contextWindow": 200000 }
}
```

**stderr 是噪音，从不解析**（只有报错时取尾部给用户看）。

因为 stdout 里可能混入 banner、进度行，插件用 `extractFirstJsonObject()` 扫描：从前向后找每个 `{`，跟踪字符串/转义/花括号深度，**第一个能闭合且 `JSON.parse` 成功的对象**即为结果。这能容忍 `}}}}` 出现在字符串里，也能跳过开头的噪音。

---

## 二、provider 注入：为什么改一个配置就能换通道

ZCode 用一套 provider 配置系统描述「有哪些模型服务可用」。它的配置结构是：

```json
{
  "schemaVersion": 1,
  "config": {
    "providerOrder":      [ ... providerId ... ],
    "providerConfigRules": { "providerRules":      [ ... ] },
    "modelConfigRules":    { "providerModelRules": [ ... ] }
  }
}
```

我们的覆盖配置长这样（`~/.dsh/zcode-provider-override.json`，由 `scripts/generate-override.mjs` 生成）：

```json
{
  "schemaVersion": 1,
  "config": {
    "providerOrder": ["dsh-glm-coding-plan"],
    "providerConfigRules": {
      "providerRules": [{
        "providerId": "dsh-glm-coding-plan",
        "providerName": "GLM Coding Plan (via ZCode)",
        "config": {
          "group": "standard-personal",
          "access": { "type": "api-key", "apiKey": "<你的套餐 Key>" },
          "api": { "type": "anthropic-messages",
                   "baseUrl": "https://open.bigmodel.cn/api/anthropic" },
          "personalModelIds": ["GLM-5.3-Flash", "GLM-5.3"],
          "modelOrder": ["GLM-5.3-Flash", "GLM-5.3"]
        }
      }]
    },
    "modelConfigRules": {
      "providerModelRules": [
        { "modelId": "GLM-5.3-Flash", "providerId": "dsh-glm-coding-plan",
          "config": { "properties": { "contextWindow": 200000 } } },
        { "modelId": "GLM-5.3", "providerId": "dsh-glm-coding-plan",
          "config": { "properties": { "contextWindow": 200000 } } }
      ],
      "manualProviderModelRules": []
    }
  }
}
```

### ⚠️ `manualProviderModelRules: []` 不是可选项

**实测结论**：ZCode 3.14.5 在解析模型时要求 `modelConfigRules` 里存在 `manualProviderModelRules` 键。**缺了它，即使其余部分完全正确，也会报**：

```
Error: Model creation failed (traceId: …)
```

A/B 验证（`node test/…` 同款脚本，真实 CLI）：

| 变体 | 结果 |
| --- | --- |
| 有 `providerModelRules` + **无** `manualProviderModelRules` | ✗ `Model creation failed` |
| 有 `providerModelRules` + `"manualProviderModelRules": []` | ✓ 正常返回 `就绪` |

所以 `lib/override.js` 里这个空数组是**故意保留**的，注释里也标注了原因。

### 选模型规则：`providerOrder[0]` 说了算

实测结论：**ZCode 选 provider 的规则是「`providerOrder` 里第一个启用的 provider」。**

而 `config.defaultModelSelection` 字段**是无效的**——实测删掉它调用照常成功，设为其他值也不改路由。所以本插件**故意不生成**这个字段（`test/register.test.mjs` 有一条断言守着这一点）。

把 `dsh-glm-coding-plan` 放在 `providerOrder[0]`，就等于「这个 CLI 的默认 provider 就是套餐通道」。

### 实测还确认了什么

用二分法（在真实 CLI 上逐个变体跑）确认的边界：

- `providerOrder` **可以**只留我们一个，不必带上 ZCode 的其余内置 provider；
- `providerConfigRules` **只需**我们那一条；
- `modelConfigRules.providerModelRules` **必须**覆盖我们声明的模型（`GLM-5.3-Flash` / `GLM-5.3`），否则同样报 `Model creation failed`；
- `manualProviderModelRules` 键**必须存在**（空数组即可）。

---

## 三、provider schema 自适应与严格性

> 本节结论全部来自 2026-10-09 的真实 CLI 实测（二分 A/B；端到端脚本 `scripts/e2e-adaptive.mjs`，手动跑，不在 `npm test` 里）。实测环境：**Windows + ZCode 3.14.5，schema revision 30**。三条事实均已实测核实并被 `test/schema.test.mjs` 的断言锁住。

personal 覆盖的解析是**严格 schema**，实测确认：

1. **路由**：ZCode 取 `providerOrder` 中第一个启用的条目作为 provider——`providerOrder[0]` 就是路由入口（见上文「选模型规则」）。
2. **必须键**：`modelConfigRules.manualProviderModelRules` 必须存在（空数组即可），缺失即 `Model creation failed`。
3. **catalog 键致命**：personal 覆盖只接受 personal 键——`providerConfigRules.providerRules`、`modelConfigRules.providerModelRules` + `manualProviderModelRules`。把 ZCode 内置目录（`zcode-builtin.json`）声明的任何一个 catalog 键——`modelRules`、`modelApiRules`、`providerSiteRules`、`templateModelRules`、`builtinProviderModelRules`、`providerConfigRules.templateRules`——复制进 personal 覆盖，都会直接 `Model creation failed`。

### 所以 lib/schema.js 做的是「校验 + 告警」，不是「镜像填充」

0.3.0 的设计曾打算「镜像 ZCode 内置目录的键集」；**实测证伪**——镜像进来的 catalog 键恰恰是致命键（事实 #3）。因此 `lib/schema.js` 的自适应层只做三件事：

1. **读**：`introspectSchema()` 读取 ZCode 内置 `zcode-builtin.json`，记录它的键集与 schema revision；
2. **判**：目录里还能看到 personal 键 → `compatible = true`，notes 写「schema 校验通过」；看不到 → `compatible = false`，告警提示对照内置配置（实测后）调整 `lib/schema.js` 的 `PERSONAL_*` 常量；
3. **生成**：无论判定结果如何，文档永远只含实测验证过的 personal 键——`CATALOG_ONLY_HINTS` 列出的 catalog 键一个都不出现（`test/schema.test.mjs` 有全树回归锁）。

对用户的含义：**ZCode 升级后，插件不会自动适配未知键**（那需要重新实测），但会在生成覆盖配置时自动检测 personal schema 是否仍兼容，并在日志 / `node scripts/setup-check.mjs` 输出告警——把「静默的 Model creation failed」变成一句明确的话。

### 降级路径

内置配置读不到（首次安装、打包异常）时，`buildOverrideConfig` 回退到静态形状并在 notes 注明「schema 自适应不可用，已回退静态形状：<原因>」；完全没传内置配置路径时是纯静态 notes「使用静态 provider 形状（未经 ZCode 内置配置自适应）」。两条降级路径产出的形状与实测验证过的 personal 契约一致。

---

## 四、为什么不碰 ZCode 的全局配置

插件**从不写入**这两个文件：

| 文件 | 作用 | 插件行为 |
| --- | --- | --- |
| ZCode 桌面端 `<数据目录>/provider_config.json` | 桌面端的 provider 注册表 | ❌ 只读不写 |
| `~/.zcode/v2/credentials.json` | ZCode 登录凭据 | ❌ 只读不写 |

原因是：这两个文件会被**正在运行的 ZCode 桌面端**随时改写，程序化写入要么被覆盖、要么造成状态不一致。

插件的做法是**每次 spawn 注入一个环境变量**，指向自己那份独立的 JSON。作用域仅限这一次子进程，退出即消失。

### 覆盖配置的存放位置

默认 `~/.dsh/zcode-provider-override.json`（可用 `DSH_ZCODE_OVERRIDE` 改）。

**为什么不放仓库目录**：仓库可能被克隆到只读共享、或每次更新都被换掉；而它是**用户数据**（内嵌真实 Key），理应待在用户自己的 profile 里。`.gitignore` 已排除该文件名。

该文件 `chmod 600`（POSIX；Windows 上无效，故仍有权限提示）。

---

## 五、多轮：`--resume`

ZCode CLI 支持 `--resume <sessionId>` 恢复会话。插件把上轮返回的 `sessionId` 透传即可：

```
第 1 轮  zcode_call({ prompt: "…" })            → sessionId: sess_A
第 2 轮  zcode_call({ prompt: "…", resume: "sess_A" })
```

最终 argv：

```
[<zcode.cjs>, --mode, <mode>, --json, --resume, sess_A, -p, <prompt>]
```

**多轮是省额度的主要原因**：续接时 ZCode 恢复完整历史，上下文几乎全命中缓存（实测 cacheRead/input ≈ 99.9%）。

---

## 六、缓存

ZCode 支持 prompt caching，插件**不参与**这件事——只是把返回的 `usage.cacheReadTokens` 原样透出，便于观测。

实测（`~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表）：

| 场景 | inputTokens | cacheReadTokens |
| --- | --- | --- |
| 全新会话首轮 | 68,334 | 3,520 |
| 系统提示已热 | 67,512 | 13,504 |
| 同 session 续接 | 68,211 | 68,160 |

---

## 七、超时、取消、并发

### 超时 / 取消

- 插件给子进程一个自管超时（`timeout_ms`，默认 15 分钟，钳制到 [30s, 60min]）；
- 超时或 `exec.signal` abort 时，**Windows 用 `taskkill /pid <pid> /T /F`**（`/T` 杀子孙进程，`/F` 强制），其他平台用 `SIGKILL`；
- 工具本身在 DSH 侧注册的 `timeoutMs` 设为 `maxTimeoutMs`，确保外层协作式预算**永远不会早于**子进程超时触发——杀子进程才是优雅路径，外层只是策略兜底。

### 并发

`isConcurrencySafe: () => false`。一次调用 ≈ 15 套餐积分，并行扇出会双倍计费并压垮机器。所以刻意串行。

### stdout 上限

`maxStdoutBytes`（16MB）与 `maxStderrBytes`（16KB）。stderr 只保留尾部——它是噪音，只在报错时给人看。

---

## 八、余量闸门

见 [README 的余量闸门一节](../README.md#余量闸门可选)。要点：

- **默认关闭**（`quotaScript` 默认为空串），fail-open；
- 启用后跑 `<python> <quotaScript> --json --plan <plan>`，读 `window_weighted/window_cap` 与 `week_weighted/weekly_cap`；
- 判定：两个百分比**都**低于阈值才放行；
- 结果缓存 60 秒；
- 闸门拒绝时**不 spawn 子进程**，毫秒级返回 `quota_insufficient`；
- `force: true` 旁路。

---

## 九、路径探测

见 [troubleshooting.md](troubleshooting.md) 的探测顺序。核心是**零硬编码机器路径**：

```
插件 config（cordis.patch.yml） > ZCODE_HOME 环境变量 > 平台探测
```

Windows 探测顺序：`ZCODE_HOME` → `%LOCALAPPDATA%\Programs\ZCode` → `%ProgramFiles%\ZCode` →
`%ProgramFiles(x86)%\ZCode` → `D:/E: Program Files\ZCode`、`D:/E:\ZCode` → **注册表 Uninstall 项** → PATH。

> 注册表那条有个实测细节：ZCode 3.14.5 的 Uninstall 项**没有 `InstallLocation`**，只能从 `UninstallString`
> （`"d:\Program Files\ZCode\Uninstall ZCode.exe" /allusers`）剥出目录。因此 `lib/paths.js` 里两个字段都读。

探测不到时返回明确错误 + 官方安装链接，**绝不回落到某台机器的猜测路径**。

---

## 相关

- [README](../README.md) — 安装与用法
- [comparison.md](comparison.md) — 为什么用它
- [troubleshooting.md](troubleshooting.md) — 出错了怎么办