#!/usr/bin/env node
// test/gate.test.mjs — quota gate unit tests, spawn fully mocked.
//
// Verifies: threshold arithmetic, fail-open when the estimator is missing or
// broken, TTL caching, force bypass, and that a blocking verdict happens
// WITHOUT spawning the CLI child process.
//
//   node test/gate.test.mjs
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { gateVerdict, createQuotaChecker, renderQuota, QUOTA_DEFAULTS } from '../lib/quota.js'

let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** A fake child process that emits the given stdout then closes. */
function fakeChild(stdout, { error = null, delayMs = 0 } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 4242
  child.exitCode = null
  child.signalCode = null
  child.kill = () => {}
  setTimeout(() => {
    if (error) {
      child.emit('error', error)
      return
    }
    if (stdout) child.stdout.emit('data', Buffer.from(stdout, 'utf8'))
    child.emit('close', 0)
  }, delayMs)
  return child
}

const SAMPLE = JSON.stringify({
  plan: 'pro',
  window_weighted: 100,
  window_cap: 400, // 25%
  week_weighted: 1000,
  weekly_cap: 2000, // 50%
})

console.log('dsh-zcode-coding-plan · quota gate tests\n')

// ── 1. percentage arithmetic + sufficient verdict ──
console.log('[1] 基本判定')
{
  let spawned = 0
  const checker = createQuotaChecker(
    { quotaScript: '/fake/quota.py', quotaRouteWindowPct: 60, quotaRouteWeekPct: 80 },
    { existsSync: () => true, spawn: () => { spawned++; return fakeChild(SAMPLE) } },
  )
  const q = await checker.check()
  check('available=true', q.available === true, JSON.stringify(q))
  check('windowPct=25', q.windowPct === 25, `got ${q.windowPct}`)
  check('weekPct=50', q.weekPct === 50, `got ${q.weekPct}`)
  check('sufficient=true (25<60 && 50<80)', q.sufficient === true)
  check('gateVerdict returns null', gateVerdict(q, false) === null)
  check('spawned exactly once', spawned === 1, `got ${spawned}`)
}

// ── 2. blocking branch: over both thresholds ──
console.log('\n[2] 拒绝分支')
{
  const OVER = JSON.stringify({
    plan: 'pro',
    window_weighted: 380, // 95% > 60
    window_cap: 400,
    week_weighted: 1900, // 95% > 80
    weekly_cap: 2000,
  })
  const checker = createQuotaChecker(
    { quotaScript: '/fake/quota.py', quotaRouteWindowPct: 60, quotaRouteWeekPct: 80 },
    { existsSync: () => true, spawn: () => fakeChild(OVER) },
  )
  const q = await checker.check()
  check('available=true', q.available === true)
  check('sufficient=false', q.sufficient === false)
  const verdict = gateVerdict(q, false)
  check('gateVerdict blocks', verdict !== null)
  check('error starts with quota_insufficient', String(verdict.error).startsWith('quota_insufficient'),
    verdict && verdict.error)
  check('verdict carries quota detail', verdict.quota === q)
  check('verdict carries hint', typeof verdict.hint === 'string' && verdict.hint.length > 0)
  check('force bypasses', gateVerdict(q, true) === null)
}

// ── 3. fail-open: script missing ──
console.log('\n[3] fail-open（脚本缺失）')
{
  const checker = createQuotaChecker(
    { quotaScript: '/nope/quota.py' },
    { existsSync: () => false, spawn: () => { throw new Error('must not spawn') } },
  )
  const q = await checker.check()
  check('available=false', q.available === false)
  check('gate passes (fail-open)', gateVerdict(q, false) === null)
}

// ── 4. fail-open: default config has no script ──
console.log('\n[4] 默认配置即跳过闸门')
{
  check('QUOTA_DEFAULTS.quotaScript is empty', QUOTA_DEFAULTS.quotaScript === '',
    `got ${JSON.stringify(QUOTA_DEFAULTS.quotaScript)}`)
  const checker = createQuotaChecker({}, { existsSync: () => false })
  const q = await checker.check()
  check('available=false', q.available === false)
  check('gate passes', gateVerdict(q, false) === null)
}

// ── 5. fail-open: script errors ──
console.log('\n[5] fail-open（脚本异常 / 输出不可解析）')
{
  const checker = createQuotaChecker(
    { quotaScript: '/fake/quota.py' },
    { existsSync: () => true, spawn: () => fakeChild(null, { error: new Error('ENOENT python') }) },
  )
  const q = await checker.check()
  check('spawn error → available=false', q.available === false)
  check('gate passes', gateVerdict(q, false) === null)

  const checker2 = createQuotaChecker(
    { quotaScript: '/fake/quota.py' },
    { existsSync: () => true, spawn: () => fakeChild('not json at all') },
  )
  const q2 = await checker2.check()
  check('unparseable → available=false', q2.available === false)
  check('gate passes', gateVerdict(q2, false) === null)
}

// ── 6. TTL cache ──
console.log('\n[6] TTL 缓存')
{
  let spawned = 0
  const mk = () => createQuotaChecker(
    { quotaScript: '/fake/quota.py', quotaCacheTtlMs: 60000 },
    { existsSync: () => true, spawn: () => { spawned++; return fakeChild(SAMPLE) } },
  )
  const checker = mk()
  await checker.check()
  await checker.check()
  await checker.check()
  check('3 checks within TTL → 1 spawn', spawned === 1, `got ${spawned}`)

  checker.reset()
  await checker.check()
  check('reset() clears cache → 2 spawns', spawned === 2, `got ${spawned}`)

  // Short TTL expires
  let n = 0
  const fast = createQuotaChecker(
    { quotaScript: '/fake/quota.py', quotaCacheTtlMs: 1 },
    { existsSync: () => true, spawn: () => { n++; return fakeChild(SAMPLE) } },
  )
  await fast.check()
  await new Promise((r) => setTimeout(r, 10))
  await fast.check()
  check('expired TTL re-runs', n === 2, `got ${n}`)
}

// ── 7. argv contract ──
console.log('\n[7] 调用参数')
{
  let seenCmd, seenArgs
  const checker = createQuotaChecker(
    { quotaScript: '/fake/quota.py', pythonExe: 'py', quotaPlan: 'pro' },
    {
      existsSync: () => true,
      spawn: (cmd, args) => {
        seenCmd = cmd
        seenArgs = args
        return fakeChild(SAMPLE)
      },
    },
  )
  await checker.check()
  check('uses configured pythonExe', seenCmd === 'py', `got ${seenCmd}`)
  check('argv is [--json, --plan, pro]',
    JSON.stringify(seenArgs) === JSON.stringify(['/fake/quota.py', '--json', '--plan', 'pro']),
    JSON.stringify(seenArgs))
}

// ── 8. render ──
console.log('\n[8] 渲染')
{
  const rendered = renderQuota({ available: false, reason: '未配置余量脚本（跳过闸门）' })
  check('unavailable render is a text block', rendered[0].type === 'text' && rendered[0].text.includes('不可用'))

  const q = {
    available: true, plan: 'pro',
    windowWeighted: 100, windowCap: 400, windowPct: 25, routeWindowPct: 60,
    weekWeighted: 1000, weekCap: 2000, weekPct: 50, routeWeekPct: 80, sufficient: true,
  }
  const r2 = renderQuota(q)
  check('sufficient render mentions 余量充足', r2[0].text.includes('余量充足'))
  const r3 = renderQuota({ ...q, sufficient: false })
  check('insufficient render mentions 余量吃紧', r3[0].text.includes('余量吃紧'))
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${pass} passed, ${fail} failed`)
if (fail) {
  console.log('failed:', failures.join(', '))
  process.exit(1)
}