#!/usr/bin/env node
// scripts/install.mjs — guided installer.
//
// Three steps, matching the README:
//   1. verify ZCode is installed (reuses resolveZCodePaths)
//   2. generate the provider override from the credentials file
//   3. print the exact cordis.patch.yml stanza + link: dependency + junction
//      command the user must add to their DSH profile
//
// It does NOT edit your DSH profile for you — the profile files are managed by
// a running desktop app and can be rewritten under you. It prints ready-to-
// paste snippets instead. Override with --copy-mode to just dump the json.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { credentialsPath, defaultOverridePath, resolveZCodePaths } from '../lib/paths.js'
import { loadCodingPlanKey, overrideLooksValid, CODES_KEY_REF } from '../lib/override.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgName = 'dsh-zcode-coding-plan'
const env = process.env
const args = process.argv.slice(2)
const showJson = args.includes('--copy-mode')

function main() {
  console.log(`${pkgName} 安装助手`)
  console.log('='.repeat(60))

  // ── step 1: ZCode ──
  const paths = resolveZCodePaths({}, { env })
  console.log('\n[1/3] ZCode 客户端')
  if (paths.ok) {
    console.log(`  ✓ ${paths.root}（${paths.source}）`)
  } else {
    console.log(`  ✗ ${paths.error}`)
    console.log(`  → ${paths.hint}`)
    return 1
  }

  // ── step 2: override ──
  const overridePath = defaultOverridePath(env)
  console.log('\n[2/3] provider 覆盖配置')
  const key = loadCodingPlanKey(env)
  if (!key) {
    console.log(`  ✗ 未找到 ${CODES_KEY_REF}（读取 ${credentialsPath(env)}）`)
    console.log('  → 在智谱平台开通 GLM Coding Plan，把 Key 加到该文件 refs 段，然后重跑本脚本')
    console.log(`    ${CODES_KEY_REF}: 你的套餐Key`)
    return 1
  }
  if (overrideLooksValid(overridePath)) {
    console.log(`  ✓ 已存在且有效: ${overridePath}`)
  } else {
    console.log(`  - 生成中: ${overridePath}`)
    console.log('  → 运行 `node scripts/generate-override.mjs` 完成本步')
  }

  // ── step 3: DSH registration ──
  console.log('\n[3/3] 注册到 DSH（需要手工粘贴三处）')
  console.log(showJson ? '  (--copy-mode: 只打印配置片段)' : '')

  console.log(`
  A) ~/.dsh/profiles/desktop/cordis.patch.yml —— 在顶层列表追加：

    - id: zcode-coding-plan
      name: ${pkgName}
      config:
        # 路径留空即自动探测；只有非标准安装才需要显式写
        zcodeExe: '${paths.zcodeExe}'
        zcodeCjs: '${paths.zcodeCjs}'
        builtinProviderConfig: '${paths.builtinProviderConfig || ''}'
        providerOverride: '${overridePath}'
        defaultMode: yolo
        defaultTimeoutMs: 900000
        # 余量闸门（可选）：填上脚本路径才有闸门，留空则直接派活
        quotaScript: ''

  B) DSH 应用目录的 package.json dependencies 追加：

    "${pkgName}": "link:${repoRoot}"

  C) node_modules 建 junction：

    node -e "require('fs').symlinkSync(${JSON.stringify(repoRoot)}, require('path').join(process.cwd(),'node_modules','${pkgName}'), 'junction')"

  然后重启 DSH 桌面端。自检：
    node ${resolve(repoRoot, 'scripts/setup-check.mjs')}
`)

  console.log('  注意: cordis.patch.yml 可能被运行中的 DSH 改写，编辑前请备份。')
  console.log(`  凭据读取位置: ${credentialsPath(env)}（只读，插件从不写入）`)
  return 0
}

process.exit(main())