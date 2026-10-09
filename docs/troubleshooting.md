# 排障

先跑自检，它会告诉你卡在哪一节：

```bash
node scripts/setup-check.mjs
```

退出码 `0` = 就绪，`1` = 缺东西，`2` = 脚本自身出错。

---

## 目录

1. [找不到 ZCode](#1-找不到-zcode)
2. [Model creation failed](#2-model-creation-failed)
3. [401 / 认证失败](#3-401--认证失败)
4. [套餐没额度 / 调用报余额不足](#4-套餐没额度--调用报余额不足)
5. [余量闸门相关](#5-余量闸门相关)
6. [工具没注册 / 改了没生效](#6-工具没注册--改了没生效)
7. [调用超时](#7-调用超时)
8. [json 路径与本机路径不通用](#8-json-路径与本机路径不通用)
9. [验证：怎么确认真的走了套餐](#9-验证怎么确认真的走了套餐)

---

## 1. 找不到 ZCode

**症状**：`setup-check` 第 [1] 节报 `✗ 未找到 ZCode 安装`；`zcode_call` 返回「未找到 ZCode 可执行文件」。

### 排查

插件按这个顺序探测（顺序即优先级）：

1. **插件 config** —— `cordis.patch.yml` 里显式写的 `zcodeExe` / `zcodeCjs` / `builtinProviderConfig` / `zcodeRoot`
2. **`ZCODE_HOME` 环境变量** —— 指向安装目录（或 `.app` bundle）
3. **平台探测**：
   - Windows：`%LOCALAPPDATA%\Programs\ZCode`、`%ProgramFiles%\ZCode`、`%ProgramFiles(x86)%\ZCode`、`D:\Program Files\ZCode`、`D:\ZCode`、`E:\Program Files\ZCode`、`E:\ZCode`、注册表 Uninstall 项、PATH
   - macOS：`/Applications/ZCode.app`、`~/Applications/ZCode.app`
   - Linux：`/opt/ZCode`、`/usr/lib/zcode`、`/usr/share/zcode`、PATH

### 解决

**a) 没装** → 装：<https://zcode.z.ai/cn/docs/install>

**b) 装在非标准位置** → 显式配置。在 `cordis.patch.yml` 的 `config:` 里写：

```yaml
        zcodeExe: 'D:/MyApps/ZCode/ZCode.exe'
        zcodeCjs: 'D:/MyApps/ZCode/resources/glm/zcode.cjs'
```

或设环境变量后重启 DSH：

```bash
# Windows (PowerShell)
[Environment]::SetEnvironmentVariable('ZCODE_HOME', 'D:\MyApps\ZCode', 'User')
```

> **macOS / Linux 提示**：路径探测是尽力而为的，**本仓库的实测验证全部在 Windows 上完成**。
> 其他平台若探测失败，请用上面的 `zcodeExe`/`zcodeCjs` 显式指定。

**c) Windows 注册表那条的细节**：ZCode 3.14.5 的 Uninstall 项**没有 `InstallLocation` 值**，插件靠从 `UninstallString` 剥出目录。
如果你装了改版 ZCode 导致这条失效，直接用环境变量或显式配置兜底。

---

## 2. Model creation failed

**症状**：

```
ZCode CLI 未输出可解析的 JSON（exitCode=1）
stderr 尾部:
Error: Model creation failed (traceId: ……)
```

这是**最常见**的坑，且几乎总是同一个原因。

### 根因

ZCode 3.14.5 在解析模型时要求 `modelConfigRules` 里存在 `manualProviderModelRules` 键。
**缺这个键（哪怕其余部分完全正确）就会报 `Model creation failed`。**

A/B 实测：

| 变体 | 结果 |
| --- | --- |
| 有 `providerModelRules`，无 `manualProviderModelRules` | ✗ Model creation failed |
| 有 `providerModelRules` + `"manualProviderModelRules": []` | ✓ 正常 |

### 解决

**优先：重新生成覆盖配置**（`lib/override.js` 已包含该键）

```bash
node scripts/generate-override.mjs --force
```

**如果你是手写/从别处复制的 JSON**，检查这三样：

1. `modelConfigRules.manualProviderModelRules` 存在（空数组即可）；
2. `modelConfigRules.providerModelRules` **覆盖了你声明的每一个模型**（`GLM-5.3-Flash` 和 `GLM-5.3` 都要有）；
3. `providerOrder[0]` 是 `dsh-glm-coding-plan`。

最小正确结构见 [how-it-works.md](how-it-works.md#provider-注入为什么改一个配置就能换通道)。

### 如果还是不行

**ZCode 大版本升级改了 schema** —— 这是已知限制。对照 ZCode 自带的内置配置看新结构：

```bash
# Windows 路径按你的安装位置调整
python -c "import json;d=json.load(open(r'D:\Program Files\ZCode\resources\config\provider\zcode-builtin.json',encoding='utf-8'));print(list(d['config'].keys()));print(json.dumps(d['config']['providerConfigRules']['providerRules'][0],ensure_ascii=False,indent=1)[:800])"
```

然后改 `lib/override.js` 里的 `buildOverrideConfig()`。

---

## 3. 401 / 认证失败

**症状**：返回里 `status` 401，或错误信息提到 `authentication` / `unauthorized` / `invalid api key`。

### 排查

**a) Key 没读到**

```bash
node scripts/setup-check.mjs     # 看 [2] 节是否 ✓
```

报 ✗ 说明 `~/.dsh/.credentials.yaml` 的 `refs:` 段缺 `BIGMODEL_CODING_PLAN_API_KEY`。加上：

```yaml
refs:
  BIGMODEL_CODING_PLAN_API_KEY: 你的套餐Key
```

**b) Key 过期 / 不是套餐 Key**

这个 Key 必须是 **GLM Coding Plan 的套餐 Key**，不是普通按量付费的 API Key。两者不能互换 —— 套餐 Key 走套餐通道，普通 Key 走余额。

去智谱控制台确认你买的是 Coding Plan，并重新取 Key。

**c) 覆盖配置里嵌的是旧 Key**

改了凭据文件但没重生成覆盖配置：

```bash
node scripts/generate-override.mjs --force
```

**d) 检查覆盖配置是否真的以 600 权限落盘**

```bash
ls -l ~/.dsh/zcode-provider-override.json
```

**别把 `zcode-provider-override.json` 提交到 git** —— `.gitignore` 已排除。

---

## 4. 套餐没额度 / 调用报余额不足

**症状**：返回里说余额不足，或套餐用量已耗尽。

### 这不是插件的问题

本插件不给你发额度。**必须有有效的 GLM Coding Plan 订阅，且当期额度未耗尽。**

### 查用量

- 套餐用量：<https://www.bigmodel.cn/coding-plan/personal/usage>
- 本地逐条记录：`~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表（见第 9 节）

### 注意计费口径

ZCode 渠道标注 **1.5 倍（150%）** 消耗。所以同样的活，套餐额度掉得比预期快 —— 这是渠道倍率，不是 bug。

### 等待刷新

套餐通常有 5 小时窗口 + 周配额两重限制。一边用完一边等刷新，或升级套餐。

---

## 5. 余量闸门相关

### 闸门默认是关的

`quotaScript` 默认**空字符串**，所以闸门**默认不生效**（fail-open，直接派活）。这是发布版的刻意选择 —— 不预设任何人的监控脚本路径。

### 开启闸门

在 `cordis.patch.yml` 的 `config:` 里填：

```yaml
        quotaScript: '/path/to/your/quota_script.py'
        quotaRouteWindowPct: 60
        quotaRouteWeekPct: 80
```

脚本契约：

```
<python> <quotaScript> --json --plan <plan>
→ stdout: {"plan":"pro","window_weighted":5,"window_cap":400,
           "week_weighted":308,"weekly_cap":2000}
```

`weighted / cap * 100` 得到百分比，两个都低于阈值才放行。

### 闸门拒绝但你觉得不该拒

看返回里的 `quota` 字段，它会告诉你实际百分比和阈值：

```
quota_insufficient: 套餐余量不足（5h 窗口 4.3%/上限0%，本周 16%/上限0%）
```

注意「上限0%」这种情况 —— 说明阈值被配成了 0，任何用量都会被拒。想强制执行用 `force: true`。

### 闸门 fail-open

脚本缺失 / spawn 失败 / 输出不可解析 / 超时（默认 10 秒）—— **一律放行**。这是刻意的：闸门是保护措施，不是硬依赖。返回值会是 `available: false` + `reason`。

---

## 6. 工具没注册 / 改了没生效

**症状**：agent 说没有 `zcode_call` 这个工具；或改了插件代码但行为没变。

### 逐项检查

**a) 日志里有没有注册行**

启动 DSH 后应看到：

```
[dsh-zcode-coding-plan] tools zcode_call + zcode_quota registered; zcode=… cjs=… override=… probe=…
```

没有这行 → 插件根本没加载。

**b) 三处注册是否都做了**

1. `~/.dsh/profiles/desktop/cordis.patch.yml` 里的 `- insert:` 条目（`name` 必须是包名 `dsh-zcode-coding-plan`）
2. DSH 应用 `package.json` 的 `dependencies` 里有 `"dsh-zcode-coding-plan": "link:C:/your/path"`
3. `node_modules/dsh-zcode-coding-plan` 是 junction 指向你的插件目录

**c) 是不是重启了**

改 `cordis.patch.yml` 和插件代码都要**重启 DSH 桌面端**。

**d) junction 断了吗**

```bash
# Windows
dir node_modules\dsh-zcode-coding-plan
```

应该指向你的插件目录，不是空目录或拷贝。

**e) `cordis.patch.yml` 被运行中的 DSH 改写过**

这个文件可能被正在运行的桌面端重写。**编辑前先备份**，编辑前重新读一遍：

```bash
cp ~/.dsh/profiles/desktop/cordis.patch.yml ~/.dsh/profiles/desktop/cordis.patch.yml.bak-zcode-$(date +%Y%m%d-%H%M%S)
```

**f) 看警告行**

如果路径/凭据有问题，插件会在注册行后面打 `⚠` 警告：

```
[dsh-zcode-coding-plan] ⚠ 未找到 ZCode 安装 …
[dsh-zcode-coding-plan] ⚠ 找不到 GLM Coding Plan 套餐 Key …
```

---

## 7. 调用超时

**症状**：`子进程超过 Nms 未返回结果，已终止`。

### 正常耗时

单轮 20 秒～几分钟（每次请求背约 66K tokens 系统提示）。超过 15 分钟才是异常。

### 调大超时

```yaml
        defaultTimeoutMs: 1800000    # 30 分钟
```

或在调用时 `zcode_call({ prompt: "…", timeout_ms: 1800000 })`。

上限 3600000（60 分钟）。下限 30000（30 秒）。

### 任务太重

如果是大型重构，拆成多轮用 `--resume` 续接，比一次性塞进去更稳。

---

## 8. json 路径与本机路径不通用

**症状**：从别人（或我之前的描述）复制了一份覆盖配置 JSON，里面带着某台机器的绝对路径。

### 原则

覆盖配置**不应该**含任何本机路径 —— 路径是插件 config 的事，不是 provider 配置的事。provider 配置只需要：

- `providerOrder`
- `providerConfigRules`（你的 provider + 套餐 Key）
- `modelConfigRules`（你的模型 + `contextWindow` + `manualProviderModelRules`）

### 解决

直接重新生成，别手抄：

```bash
node scripts/generate-override.mjs --force
```

---

## 9. 验证：怎么确认真的走了套餐

### 查 ZCode 本地审计库

ZCode 把每次调用记在 `~/.zcode/cli/db/db.sqlite`（约 440MB，**务必只读**打开）：

```bash
python -c "
import sqlite3
con = sqlite3.connect('file:' + r'C:\Users\你的用户名\.zcode\cli\db\db.sqlite?mode=ro', uri=True)
for r in con.execute('select session_id, provider_id, model_id, status, input_tokens from model_usage order by rowid desc limit 5'):
    print(r)
"
```

**期望**：`provider_id == 'dsh-glm-coding-plan'`、`model_id == 'GLM-5.3-Flash'`、`status == 'completed'`。

**如果 provider_id 是别的值** → 覆盖配置没生效。最可能是 `providerOrder[0]` 不是我们的 provider。

> ⚠️ 这个库有 440MB 且被 ZCode 活动写入，**必须**用 `file:...?mode=ro` 只读 URI 打开。不要直接 `sqlite3 xxx.db`。

### 跨平台路径

| 系统 | 路径 |
| --- | --- |
| Windows | `%USERPROFILE%\.zcode\cli\db\db.sqlite` |
| macOS / Linux | `~/.zcode/cli/db/db.sqlite` |

---

## 还是不行？

1. 跑 `node scripts/setup-check.mjs`，把完整输出贴出来；
2. 跑 `node scripts/e2e-smoke.mjs "回复两个字：就绪"`，看原始返回和 stderr；
3. 对照 [how-it-works.md](how-it-works.md) 检查覆盖配置结构；
4. 查 ZCode 版本（`setup-check` 会显示）：schema 随版本变化，老教程可能不适用。

官方文档：<https://zcode.z.ai/cn/docs>