# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-10-09

### 新增

- **`lib/schema.js`**：provider schema 校验与告警层。读取 ZCode 内置 provider 配置
  （`zcode-builtin.json`），判定本插件生成的 personal 覆盖结构是否仍被当前 ZCode
  版本识别；不识别时在生成 notes / 插件日志 / `scripts/setup-check.mjs` 输出明确
  告警，而不是等派活时报 `Model creation failed`。
- **`test/schema.test.mjs`**（76 断言，mock fixture，零计费）：锁定三条实测事实
  （`providerOrder[0]` 路由 / `manualProviderModelRules` 必须存在 / catalog 键致命），
  以及「任何生成路径的 doc 全树不含 catalog 键」的回归锁。
- **`scripts/e2e-adaptive.mjs`**：真实自适应验证脚本——按真实内置 schema 生成覆盖并
  派一次真实调用确认路由（手动跑，不入 `npm test`）。
- **`scripts/setup-check.mjs`**：新增 schema 兼容性检查项（仍零真实调用）。
- 文档：`docs/how-it-works.md` 新增「provider schema 自适应与严格性」一节；
  `docs/troubleshooting.md` 第 2 节更新诊断步骤（先跑 setup-check 看 schema 告警）。

### 重要发现（改变了 0.3.0 的设计）

- **尝试过「镜像 ZCode 内置 catalog 键」的方案，实测被 ZCode 拒绝**：在 personal 覆盖
  的 `modelConfigRules` / `providerConfigRules` 里加入任何一个 catalog 键
  （`modelRules`、`modelApiRules`、`providerSiteRules`、`templateModelRules`、
  `builtinProviderModelRules`、`providerConfigRules.templateRules`），都会导致
  `Model creation failed`。实测方式：真实 CLI 二分 A/B（Windows + ZCode 3.14.5，
  schema revision 30）。因此自适应层改为**校验 + 告警**：只生成实测验证过的
  personal 键，绝不镜像 catalog 键；ZCode 升级后自动检测兼容性并告警，而不是自动
  适配未知键。

## [0.2.0] - 2026-10-09

### 新增

- **余量感知自动路由**：`zcode_quota` 只读工具 + `zcode_call` 内置余量闸门
  （默认 5h 窗口 <60% 且本周 <80% 才放行，`force: true` 可旁路，TTL 缓存 60s，检查失败 fail-open）。
- **跨平台路径探测** `lib/paths.js`：注册表 / 常见安装目录 / `ZCODE_HOME`，
  不再硬编码任何机器路径；探测失败返回明确错误与官方安装链接。
- **`scripts/setup-check.mjs`**：一键环境自检（ZCode、套餐 Key、覆盖配置、余量脚本、用量库），带退出码。
- **`scripts/install.mjs`**：安装助手，打印 cordis patch 片段、`link:` 依赖与 junction 指令。
- **`scripts/generate-override.mjs`**：依 `~/.dsh/.credentials.yaml` 生成 provider 覆盖配置。
- **三套测试**（mock spawn，零计费）：register 70 断言 / gate 30 断言 / negative-gate 14 断言。
- **`docs/`**：`comparison.md`、`how-it-works.md`、`troubleshooting.md`（9 类排障场景）。

### 修复

- **`modelConfigRules.manualProviderModelRules` 键缺失导致 `Model creation failed`**
  （ZCode 解析模型时强制要求该键存在，空数组即可）。A/B 实测定位，
  见 `docs/troubleshooting.md` 第 2 节。

### 已知限制

- macOS / Linux 路径探测未在本机验证（实测环境：Windows + ZCode 3.14.5）。
- ZCode 升级可能变更 provider schema，需按 `docs/troubleshooting.md` 第 2 节调整。
- 每次新会话约 49K–66K tokens 系统提示开销；计费按请求次数而非提示长度。

## [0.1.0] - 2026-10-08

### 新增

- 首个可用版本：驱动 ZCode 官方 CLI 的 `zcode_call` 工具，支持 `--resume` 多轮续接。
