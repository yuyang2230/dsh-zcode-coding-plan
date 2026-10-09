#!/usr/bin/env node
// scripts/setup-check.mjs — one-shot environment self check.
//
// Answers "will this plugin work for me?" in one command: ZCode found? CLI
// entry present? coding-plan key readable? override json present? quota script
// present?
//
// Exit codes (so CI / a setup wizard can branch on them):
//   0  ready           — ZCode + key + override all good
//   1  not ready      — something actionable is missing
//   2  usage/setup error
import { existsSync, statSync } from 'node:fs'
import { credentialsPath, defaultOverridePath, resolveZCodePaths, zcodeUsageDb } from '../lib/paths.js'
import { loadCodingPlanKey, overrideLooksValid, CODES_KEY_REF } from '../lib/override.js'
import { introspectSchema } from '../lib/schema.js'
import { QUOTA_DEFAULTS } from '../lib/quota.js'

const env = process.env
const overrides = loadCliArgs()
const ok = (m) => `  ✓ ${m}`
const bad = (m) => `  ✗ ${m}`
const warn = (m) => `  ! ${m}`

function loadCliArgs() {
  const out = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--quota-script') out.quotaScript = argv[++i]
    else if (a.startsWith('--quota-script=')) out.quotaScript = a.split('=').slice(1).join('=')
    else if (a === '--override') out.providerOverride = argv[++i]
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

function main() {
  if (overrides.help) {
    console.log('usage: node scripts/setup-check.mjs [--quota-script <path>] [--override <path>]')
    return 0
  }

  console.log('dsh-zcode-coding-plan · 环境自检')
  console.log(`platform: ${process.platform} ${process.arch} · node ${process.version}`)
  console.log('')

  const failures = []

  // 1) ZCode install
  console.log('[1] ZCode 客户端')
  const paths = resolveZCodePaths(overrides, { env })
  if (paths.ok) {
    console.log(ok(`安装根目录 ${paths.root}（来源: ${paths.source}）`))
    console.log(ok(`CLI 入口 ${paths.zcodeCjs}`))
    console.log(ok(`可执行 ${paths.zcodeExe}`))
    if (paths.builtinProviderConfig) {
      console.log(ok(`内置 provider 配置 ${paths.builtinProviderConfig}`))
      // schema 兼容性判定（lib/schema.js）：personal 覆盖是严格 schema，catalog
      // 键致命（实测见 docs/how-it-works.md「provider schema 自适应与严格性」）。
      // 这里只读 ZCode 内置配置文件做判定，不做任何真实调用。
      const shape = introspectSchema(paths.builtinProviderConfig)
      const rev = shape.revision !== undefined ? `（schema revision ${shape.revision}）` : ''
      if (shape.declaresPersonalKeys === false) {
        console.log(bad(`schema 兼容性：内置目录里已看不到 personal provider 键${rev}，personal 覆盖结构可能已变更`))
        console.log(warn('若派活报 Model creation failed，请对照该内置配置实测后调整 lib/schema.js 的 PERSONAL_* 常量（见 docs/troubleshooting.md 第 2 节）'))
        failures.push('schema 兼容性')
      } else {
        console.log(ok(`schema 兼容性：personal 覆盖键仍被内置目录识别${rev}`))
      }
    } else {
      console.log(warn('内置 provider 配置未找到；ZCode 将回退默认 provider 配置（可能影响 providerOrder），插件将使用静态 provider 形状'))
    }
  } else {
    console.log(bad(paths.error))
    console.log(warn(paths.hint))
    failures.push('ZCode 安装')
  }
  console.log('')

  // 2) coding-plan credential
  console.log('[2] GLM Coding Plan 套餐 Key')
  const credFile = env.DSH_CREDENTIALS_FILE || credentialsPath(env)
  const key = loadCodingPlanKey(env)
  if (key) {
    console.log(ok(`找到 ${CODES_KEY_REF}（长度 ${key.length}，值不回显）`))
  } else {
    console.log(bad(`${CODES_KEY_REF} 未在 ${credFile} 的 refs 段找到`))
    console.log(warn('请先在智谱平台开通 GLM Coding Plan，然后加一行：'))
    console.log(warn(`  ${CODES_KEY_REF}: 你的套餐Key`))
    failures.push('套餐 Key')
  }
  console.log('')

  // 3) provider override json
  console.log('[3] provider 覆盖配置')
  const overridePath = overrides.providerOverride || defaultOverridePath(env)
  if (existsSync(overridePath)) {
    const valid = overrideLooksValid(overridePath)
    if (valid) console.log(ok(`${overridePath}（providerOrder[0] 已指向 dsh-glm-coding-plan）`))
    else {
      console.log(warn(`${overridePath} 存在但 providerOrder[0] 不是 dsh-glm-coding-plan，可能不会走套餐`))
      failures.push('覆盖配置内容')
    }
    try {
      const s = statSync(overridePath)
      console.log(warn(`⚠ 该文件内嵌了真实 API Key，不要提交到 git（mode=${(s.mode & 0o777).toString(8)}）`))
    } catch { /* ignore */ }
  } else {
    console.log(bad(`不存在: ${overridePath}`))
    console.log(warn('运行 `node scripts/generate-override.mjs` 生成（需要上面的套餐 Key）'))
    failures.push('覆盖配置')
  }
  console.log('')

  // 4) optional quota gate
  console.log('[4] 余量闸门（可选）')
  const quotaScript = overrides.quotaScript || env.DSH_QUOTA_SCRIPT || QUOTA_DEFAULTS.quotaScript
  if (quotaScript && existsSync(quotaScript)) {
    console.log(ok(`余量脚本 ${quotaScript}`))
    console.log(warn('闸门是可选的；找不到也会跳过（fail-open），只是失去自动分流保护'))
  } else {
    console.log(`  - 未配置余量脚本${quotaScript ? `（${quotaScript} 不存在）` : ''} → 闸门跳过，直接派活`)
  }
  console.log('')

  // 5) verification channel (informational)
  console.log('[5] 验证通道（ZCode 用量库，只读查询）')
  const db = zcodeUsageDb(env)
  console.log(`  ${existsSync(db) ? '✓' : '-'} ${db}`)
  if (existsSync(db)) {
    console.log('    调用后可用 `python -c` 以 sqlite file:...?mode=ro 打开，检查最新一行：')
    console.log("    select provider_id, model_id from model_usage order by rowid desc limit 1;")
    console.log('    期望 provider_id=dsh-glm-coding-plan')
  }
  console.log('')

  // verdict
  if (failures.length === 0) {
    console.log('RESULT: ✓ 就绪 — 可以用 zcode_call 派活')
    return 0
  }
  console.log(`RESULT: ✗ 未就绪 — 缺少: ${failures.join('、')}`)
  return 1
}

try {
  process.exit(main())
} catch (err) {
  console.error('setup-check 失败:', err && err.stack ? err.stack : err)
  process.exit(2)
}