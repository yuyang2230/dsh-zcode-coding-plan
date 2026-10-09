// lib/quota.js — optional plan-headroom gate.
//
// Splits the "can we afford this call?" question out of index.js so it can be
// tested with a mocked spawn. The gate is entirely OPTIONAL and fail-open:
// if the user has no local quota estimator installed, calls still go through.
//
// Contract of the estimator script (any program that honours this works —
// the reference implementation ships with the original private setup, not
// with this repo):
//
//   <python> <quotaScript> --json --plan <plan>
//   → stdout: {"plan":"pro","window_weighted":5,"window_cap":400,
//              "week_weighted":308,"weekly_cap":2000, ...}
//   weighted/cap are the same unit; usage% = weighted / cap * 100.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export const QUOTA_DEFAULTS = {
  // Empty by default: a published repo has no business pointing at one
  // machine's monitoring scripts. Gate silently skips unless configured.
  pythonExe: 'python',
  quotaScript: '',
  quotaPlan: 'pro',
  quotaRouteWindowPct: 60,
  quotaRouteWeekPct: 80,
  quotaCacheTtlMs: 60000,
  quotaTimeoutMs: 10000,
}

const pct = (weighted, cap) => (cap ? (weighted / cap) * 100 : 0)
const round1 = (n) => Math.round(n * 10) / 10

/**
 * Create a quota checker bound to `cfg`.
 *
 * @param {object} cfg    plugin config merged over QUOTA_DEFAULTS
 * @param {object} [deps] { spawn, existsSync } — injected by tests
 */
export function createQuotaChecker(cfg = {}, deps = {}) {
  const spawnFn = deps.spawn || spawn
  const existsFn = deps.existsSync || existsSync
  const conf = { ...QUOTA_DEFAULTS, ...cfg }
  // Cached per checker so one session doesn't re-run the estimator on every
  // back-to-back call; only successful reads populate the cache.
  let cache = { at: 0, value: null }

  function reset() {
    cache = { at: 0, value: null }
  }

  async function check({ force = false } = {}) {
    if (!conf.quotaScript || !existsFn(conf.quotaScript)) {
      return { available: false, reason: '未配置余量脚本（跳过闸门）' }
    }
    if (cache.value && Date.now() - cache.at < conf.quotaCacheTtlMs) return cache.value

    const value = await run()
    if (value.available) cache = { at: Date.now(), value }
    return value
  }

  function run() {
    return new Promise((settle) => {
      let child
      try {
        child = spawnFn(conf.pythonExe, [conf.quotaScript, '--json', '--plan', conf.quotaPlan], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (err) {
        settle({ available: false, reason: `余量脚本 spawn 失败: ${err && err.message}` })
        return
      }

      const chunks = []
      let errText = ''
      let done = false
      const finish = (v) => {
        if (done) return
        done = true
        clearTimeout(timer)
        try { child.kill() } catch { /* already exited */ }
        settle(v)
      }
      const timer = setTimeout(
        () => finish({ available: false, reason: `余量检查超时(${conf.quotaTimeoutMs}ms)` }),
        conf.quotaTimeoutMs,
      )

      child.stdout.on('data', (c) => chunks.push(c))
      child.stderr.on('data', (c) => {
        if (errText.length < 2000) errText += c.toString('utf8')
      })
      child.on('error', (err) =>
        finish({ available: false, reason: `余量脚本 spawn 失败: ${err && err.message}` }),
      )
      child.on('close', () => {
        let q
        try {
          q = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          const tail = errText.slice(0, 200)
          finish({ available: false, reason: `余量脚本输出不可解析${tail ? ': ' + tail : ''}` })
          return
        }
        const windowPct = round1(pct(q.window_weighted, q.window_cap))
        const weekPct = round1(pct(q.week_weighted, q.weekly_cap))
        finish({
          available: true,
          // Route only while BOTH windows sit under their lines — this is the
          // warning threshold of a typical quota watcher, inverted.
          sufficient: windowPct < conf.quotaRouteWindowPct && weekPct < conf.quotaRouteWeekPct,
          plan: q.plan,
          windowWeighted: q.window_weighted,
          windowCap: q.window_cap,
          windowPct,
          weekWeighted: q.week_weighted,
          weekCap: q.weekly_cap,
          weekPct,
          routeWindowPct: conf.quotaRouteWindowPct,
          routeWeekPct: conf.quotaRouteWeekPct,
        })
      })
    })
  }

  return { check, reset, config: conf }
}

/**
 * Turn a quota verdict into the tool's error payload.
 * Returns null when the call may proceed (fail-open).
 */
export function gateVerdict(q, force) {
  if (force) return null
  if (!q || !q.available) return null // fail-open: estimator missing/unreadable
  if (q.sufficient) return null
  return {
    error:
      `quota_insufficient: 套餐余量不足（5h 窗口 ${q.windowPct}%/上限${q.routeWindowPct}%，` +
      `本周 ${q.weekPct}%/上限${q.routeWeekPct}%），本次未派给 ZCode`,
    quota: q,
    hint: '等额度刷新后重试；确认要强行执行可传 force:true',
  }
}

export function renderQuota(q) {
  if (!q || !q.available) {
    return [{ type: 'text', text: `余量查询不可用: ${q && q.reason ? q.reason : '未知'}` }]
  }
  const lines = [
    `套餐 ${q.plan}: 5h 窗口 ${q.windowWeighted}/${q.windowCap}（${q.windowPct}%，路由线 ${q.routeWindowPct}%）`,
    `本周 ${q.weekWeighted}/${q.weekCap}（${q.weekPct}%，路由线 ${q.routeWeekPct}%）`,
    q.sufficient
      ? '✓ 余量充足 → 重活可自动派给 zcode_call'
      : '✗ 余量吃紧 → 本地执行，或 force:true 强行',
  ]
  return [{ type: 'text', text: lines.join('\n') }]
}