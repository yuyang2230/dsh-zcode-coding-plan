#!/usr/bin/env node
// test/negative-gate.test.mjs — proves the quota gate REJECTS a call with
// `quota_insufficient` and, critically, returns FAST without spawning the ZCode
// child process.
//
// Portable by design: the "quota script" is a generated Node stub run through
// `process.execPath`, so the gate's real spawn/parse path is exercised without
// depending on Python or on any one machine's monitoring scripts. Set
// DSH_QUOTA_SCRIPT to additionally exercise your own estimator.
//
// The ZCode spawn stub THROWS if called, so any accidental spawn fails loudly.
//
//   node test/negative-gate.test.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zcodeCallTool, resolveConfig } from '../lib/index.js'

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('dsh-zcode-coding-plan · negative quota gate test\n')

const tmp = mkdtempSync(join(tmpdir(), 'dsh-zcode-gate-'))

/** A stand-in estimator: prints the contract JSON no matter what args it gets. */
function makeStub(payload) {
  const file = join(tmp, `quota-stub-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(file, `console.log(${JSON.stringify(JSON.stringify(payload))})\n`, 'utf8')
  return file
}

const toolWithConfig = (config, spawnImpl) => {
  const { cfg } = resolveConfig(config)
  return zcodeCallTool(cfg, { spawn: spawnImpl })
}

/** Fake ZCode child that returns a canned response. */
function fakeZcode(response, tag) {
  return () => {
    const c = new EventEmitter()
    c.stdout = new EventEmitter()
    c.stderr = new EventEmitter()
    c.pid = 1234
    c.exitCode = null
    c.signalCode = null
    c.kill = () => {}
    setTimeout(() => {
      c.stdout.emit('data', Buffer.from(JSON.stringify({ sessionId: tag, response }), 'utf8'))
      c.emit('close', 0)
    }, 5)
    return c
  }
}

console.log('[1] 阈值配成必拒 → quota_insufficient，且完全不 spawn ZCode')
{
  // 10% usage against a 0% threshold: any usage is "insufficient".
  const stub = makeStub({
    plan: 'pro', window_weighted: 40, window_cap: 400, week_weighted: 200, weekly_cap: 2000,
  })
  let spawnCalls = 0
  const call = toolWithConfig(
    { pythonExe: process.execPath, quotaScript: stub, quotaRouteWindowPct: 0, quotaRouteWeekPct: 0 },
    () => { spawnCalls++; throw new Error('FAIL: ZCode CLI must NOT spawn when the gate rejects') },
  )

  const t0 = Date.now()
  const r = await call.execute({ prompt: '回复OK' }, { signal: new AbortController().signal })
  const elapsed = Date.now() - t0

  check('returned an error', !!r.error, JSON.stringify(r))
  check('error is quota_insufficient', String(r.error).startsWith('quota_insufficient'), r.error)
  check('carries quota detail', !!r.quota && r.quota.available === true, JSON.stringify(r.quota))
  check('quota reports sufficient=false', r.quota && r.quota.sufficient === false)
  check('quota parsed the percentages', r.quota && r.quota.windowPct === 10 && r.quota.weekPct === 10,
    JSON.stringify({ w: r.quota?.windowPct, k: r.quota?.weekPct }))
  check('carries an actionable hint', typeof r.hint === 'string' && r.hint.includes('force:true'), r.hint)
  check('ZCode CLI never spawned', spawnCalls === 0, `spawnCalls=${spawnCalls}`)
  check('returned fast (<15s — it never ran the CLI)', elapsed < 15000, `${elapsed}ms`)
  console.log(`    用时 ${elapsed}ms；quota: window=${r.quota.windowPct}% (线 ${r.quota.routeWindowPct}%), week=${r.quota.weekPct}% (线 ${r.quota.routeWeekPct}%)`)
  console.log(`    error: ${r.error}`)
}

console.log('\n[2] force:true 旁路闸门（放行并真的派活）')
{
  const stub = makeStub({
    plan: 'pro', window_weighted: 40, window_cap: 400, week_weighted: 200, weekly_cap: 2000,
  })
  let spawned = 0
  const call = toolWithConfig(
    { pythonExe: process.execPath, quotaScript: stub, quotaRouteWindowPct: 0, quotaRouteWeekPct: 0 },
    fakeZcode('FORCED-OK', 'sess-forced'),
  )
  const inner = fakeZcode('FORCED-OK', 'sess-forced')
  const counting = () => { spawned++; return inner() }
  const call2 = toolWithConfig(
    { pythonExe: process.execPath, quotaScript: stub, quotaRouteWindowPct: 0, quotaRouteWeekPct: 0 },
    counting,
  )
  void call
  const r = await call2.execute({ prompt: '回复OK', force: true }, { signal: new AbortController().signal })
  check('force bypassed the gate and spawned ZCode', spawned === 1, `spawned=${spawned}`)
  check('force got a real response', r && r.response === 'FORCED-OK', JSON.stringify(r))
}

console.log('\n[3] 未配置 quotaScript → fail-open，直接派活')
{
  let spawned = 0
  const inner = fakeZcode('OPEN-OK', 'sess-open')
  const call = toolWithConfig({}, () => { spawned++; return inner() })
  const r = await call.execute({ prompt: 'hi' }, { signal: new AbortController().signal })
  check('no quotaScript still dispatches', r && r.response === 'OPEN-OK', JSON.stringify(r))
  check('spawned once', spawned === 1, `spawned=${spawned}`)

  const q = await toolWithConfig({}, () => inner()).execute({})
  void q
}

console.log('\n[4] quotaScript 指向不存在的路径 → 静默跳过闸门（不报错）')
{
  let spawned = 0
  const inner = fakeZcode('MISSING-SCRIPT-OK', 'sess-missing')
  const call = toolWithConfig(
    { pythonExe: process.execPath, quotaScript: join(tmp, 'definitely-not-here.py') },
    () => { spawned++; return inner() },
  )
  const r = await call.execute({ prompt: 'hi' }, { signal: new AbortController().signal })
  check('missing script does NOT block the call', r && r.response === 'MISSING-SCRIPT-OK', JSON.stringify(r))
  check('missing script did spawn ZCode', spawned === 1, `spawned=${spawned}`)
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${pass} passed, ${fail} failed`)
if (fail) {
  console.log('failed:', failures.join(', '))
  process.exit(1)
}