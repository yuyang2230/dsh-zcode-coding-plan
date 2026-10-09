// Real end-to-end check for the schema-adaptive override:
// generate one from the actual ZCode builtin schema, then dispatch a real call
// with it and confirm the provider actually routes.
//   node scripts/e2e-adaptive.mjs
import { execFileSync, spawn as realSpawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolveZCodePaths } from '../lib/paths.js'
import { buildOverrideConfig, loadCodingPlanKey } from '../lib/override.js'
import { introspectSchema, validateAgainstShape } from '../lib/schema.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const env = process.env
const paths = resolveZCodePaths({}, { env })
if (!paths.ok) {
  console.error('✗ 未找到 ZCode：', paths.error)
  process.exit(1)
}
console.log('builtin schema:', paths.builtinProviderConfig)

const shape = introspectSchema(paths.builtinProviderConfig)
console.log('introspected :', shape.source, 'rev', shape.revision, shape.catalogModelRuleKeys.join(','))

const key = loadCodingPlanKey(env)
if (!key) { console.error('✗ 没有套餐 Key'); process.exit(1) }

const { doc, notes } = buildOverrideConfig({ apiKey: key, builtinProviderConfig: paths.builtinProviderConfig })
for (const n of notes) console.log('  ·', n)

const problems = validateAgainstShape(doc, shape)
console.log('validate     :', problems.length ? problems.join('; ') : 'clean ✓')

const dir = execFileSync(process.execPath, ['-e',
  "const {mkdtempSync}=require('fs');const {tmpdir}=require('os');const {join}=require('path');process.stdout.write(mkdtempSync(join(tmpdir(),'adaptive-')))"],
  { encoding: 'utf8' }).trim()
const ov = join(dir, 'override.json')
writeFileSync(ov, JSON.stringify(doc, null, 2), 'utf8')
console.log('override     :', ov)

const t0 = Date.now()
const mod = await import('../lib/index.js')
const { cfg } = mod.resolveConfig({
  zcodeExe: paths.zcodeExe,
  zcodeCjs: paths.zcodeCjs,
  builtinProviderConfig: paths.builtinProviderConfig,
  providerOverride: ov,
  quotaScript: '',
})
const tool = mod.zcodeCallTool(cfg, { spawn: realSpawn })
const res = await tool.execute({ prompt: '回复两个字：就绪', cwd: dir, timeout_ms: 420000 },
  { signal: new AbortController().signal })

console.log(`elapsed      : ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log('response     :', JSON.stringify(res.response))
console.log('sessionId    :', res.sessionId)
if (res.error) { console.error('✗ 真实调用失败:', res.error); process.exit(1) }
console.log('✓ 自适应产物可真实调用')