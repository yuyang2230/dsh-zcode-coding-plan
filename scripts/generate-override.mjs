#!/usr/bin/env node
// scripts/generate-override.mjs — write the ZCode provider-override json.
//
// Reads the coding-plan key from DSH's credentials file and emits an override
// that puts `dsh-glm-coding-plan` first in providerOrder. Refuses to clobber an
// existing override without --force, and never prints the key.
//
//   node scripts/generate-override.mjs [--out <path>] [--force] [--print]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { credentialsPath, defaultOverridePath, resolveZCodePaths } from '../lib/paths.js'
import { buildOverrideConfig, loadCodingPlanKey, overrideLooksValid, CODES_KEY_REF } from '../lib/override.js'

function parseArgs() {
  const out = { force: false, print: false }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') out.out = argv[++i]
    else if (a.startsWith('--out=')) out.out = a.slice('--out='.length)
    else if (a === '--builtin') out.builtin = argv[++i]
    else if (a.startsWith('--builtin=')) out.builtin = a.slice('--builtin='.length)
    else if (a === '--force') out.force = true
    else if (a === '--print') out.print = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

const args = parseArgs()
if (args.help) {
  console.log('usage: node scripts/generate-override.mjs [--out <path>] [--builtin <zcode-builtin.json>] [--force] [--print]')
  console.log('  --builtin  ZCode 内置 provider 配置路径；给定时按该版本的 schema 自适应生成')
  console.log('  不给则自动探测；探测不到则回退到静态形状')
  process.exit(0)
}

const env = process.env
const outPath = args.out || env.DSH_ZCODE_OVERRIDE || defaultOverridePath(env)
const key = loadCodingPlanKey(env)

if (!key) {
  console.error(`✗ 未找到 ${CODES_KEY_REF}`)
  console.error(`  读取位置: ${credentialsPath(env)}`)
  console.error('  请先在智谱平台开通 GLM Coding Plan，然后在 refs 段加一行：')
  console.error(`    ${CODES_KEY_REF}: 你的套餐Key`)
  process.exit(1)
}

if (overrideLooksValid(outPath) && !args.force) {
  console.log(`✓ 覆盖配置已存在且看起来正确: ${outPath}`)
  console.log('  如需覆盖，加 --force。')
  process.exit(0)
}

// Schema-adaptive generation: when we can locate ZCode's own builtin provider
// config, mirror its key set. Auto-detected unless --builtin says otherwise.
let builtin = args.builtin
if (!builtin) {
  try {
    const paths = resolveZCodePaths({}, { env })
    if (paths && paths.ok) builtin = paths.builtinProviderConfig
  } catch { /* detection is best-effort; static shape below */ }
}

const built = buildOverrideConfig({ apiKey: key, builtinProviderConfig: builtin })
const doc = built.doc
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, JSON.stringify(doc, null, 2), { encoding: 'utf8' })

// Try to restrict to the owner on POSIX; harmless no-op failure on Windows.
try {
  const { chmodSync } = await import('node:fs')
  chmodSync(outPath, 0o600)
} catch { /* best effort */ }

console.log(`✓ 已生成 provider 覆盖配置: ${outPath}`)
for (const note of built.notes || []) console.log(`  · ${note}`)
console.log(`  providerOrder[0] = ${doc.config.providerOrder[0]}`)
console.log(`  baseUrl           = ${doc.config.providerConfigRules.providerRules[0].config.api.baseUrl}`)
console.log(`  models            = ${doc.config.providerConfigRules.providerRules[0].config.modelOrder.join(', ')}`)
console.log('  ⚠ 该文件内嵌真实 API Key，请勿提交到 git。')

if (args.print) {
  const redacted = JSON.parse(JSON.stringify(doc))
  redacted.config.providerConfigRules.providerRules[0].config.access.apiKey = '***REDACTED***'
  console.log(redacted)
}