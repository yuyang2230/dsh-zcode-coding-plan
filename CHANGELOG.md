# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
