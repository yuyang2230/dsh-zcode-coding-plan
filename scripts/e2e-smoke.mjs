// scripts/e2e-smoke.mjs — one REAL zcode_call against the local ZCode install.
// Costs real coding-plan credits (~15). Kept out of `npm test` on purpose.
//   node scripts/e2e-smoke.mjs "<prompt>" [cwd]
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, zcodeCallTool } from '../lib/index.js'
import { zcodeUsageDb } from '../lib/paths.js'

const prompt = process.argv[2] || '回复两个字：就绪'
const cwd = process.argv[3] || mkdtempSync(join(tmpdir(), 'dsh-zcode-e2e-'))

const { cfg, problems } = resolveConfig({})
console.log('zcodeExe :', cfg.zcodeExe)
console.log('zcodeCjs :', cfg.zcodeCjs)
console.log('override :', cfg.providerOverride)
console.log('probe    :', cfg.probeSource)
console.log('cwd      :', cwd)
if (problems.length) {
  console.log('\n⚠ problems:')
  for (const p of problems) console.log('  -', p)
}

const call = zcodeCallTool(cfg)
const t0 = Date.now()
const value = await call.execute({ prompt, cwd, timeout_ms: 600000 }, {
  signal: new AbortController().signal,
})
console.log(`\nelapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log('\n--- raw value ---')
console.log(JSON.stringify(value, null, 2))
console.log('\n--- rendered ---')
for (const b of call.output.render({ prompt }, value)) console.log(b.text)

console.log('\n--- verification: ZCode usage db (read-only) ---')
console.log('db:', zcodeUsageDb())
if (!value || value.error) {
  console.log('call failed, skipping db check')
  process.exit(1)
}
console.log('sessionId:', value.sessionId)