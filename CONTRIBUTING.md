# 贡献指南

感谢参与。这个项目很小，流程也简单。

## 开发环境

- Node.js **18+**（开发时用 22 验证）
- 无需安装 ZCode、无需套餐 Key —— 三套测试全部使用 mock spawn，**零计费**、不依赖外部程序

## 常用命令

```bash
npm test          # 三套测试：register / gate / negative-gate（不产生任何真实调用）
npm run check     # 环境自检（需要真的装了 ZCode 才有意义）
npm run test:smoke  # 真实端到端调用 —— 会消耗套餐积分，慎用
```

## 提交前必须保证

1. `npm test` 全绿（114 断言）
2. 新增行为在 `test/` 里有对应断言；**测试不得发起真实调用**
3. 涉及 ZCode 行为的改动，同步更新 `docs/how-it-works.md`
4. **绝不提交** `zcode-provider-override.json`（内含用户真实 Key，`.gitignore` 已挡，但请再确认）

## 硬性约束（改动时务必遵守）

- **不要修改** ZCode 桌面端 provider 注册表（`…/.zcode/v2/provider_config.json`）
- **不要修改** `~/.zcode/v2/credentials.json`
- 不要在代码里硬编码任何机器路径；一切路径走 `lib/paths.js` 探测或插件 config
- 不要引入真实 API Key、token 或其他凭证

## provider 配置结构的两个硬性要求

生成覆盖配置时（`lib/override.js`），以下两点缺一不可，否则 ZCode 报 `Model creation failed`：

1. `modelConfigRules.providerModelRules` 必须覆盖 `personalModelIds` 里声明的**每一个**模型
2. `modelConfigRules.manualProviderModelRules` **键必须存在**（值可以是空数组 `[]`）

背景与 A/B 实测见 `docs/troubleshooting.md` 第 2 节。
