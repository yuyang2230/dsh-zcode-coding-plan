#!/usr/bin/env node
// test/register.test.mjs — plugin registration, tool schema, cwd resolution,
// JSON extraction, and the no-spawn fast-return paths. No real ZCode needed.
//
//   node test/register.test.mjs
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as mod from '../lib/index.js'
import { findZCodeRoot, resolveZCodePaths, defaultOverridePath, credentialsPath } from '../lib/paths.js'
import { readCredentialRef, buildOverrideConfig, loadCodingPlanKey, overrideLooksValid } from '../lib/override.js'

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

/** Mock ctx collecting registered tool definitions. */
function mockCtx() {
  const registered = []
  return { registered, ctx: { tools: { register: (d) => registered.push(d) }, effect() {} } }
}

/** Fake child process emitting a canned ZCode stdout JSON object. */
function fakeZcodeChild(payload, { exitCode = 0 } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 9999
  child.exitCode = null
  child.signalCode = null
  child.kill = () => {}
  setTimeout(() => {
    child.stdout.emit('data', Buffer.from(`boot noise\n${JSON.stringify(payload)}\n`, 'utf8'))
    child.emit('close', exitCode)
  }, 5)
  return child
}

let spawnCount = 0
let lastSpawn = null
/** Build zcode_call over a mock spawn so tests never bill a real call. */
function mockCallTool(config = {}) {
  spawnCount = 0
  lastSpawn = null
  const { cfg } = mod.resolveConfig(config)
  return mod.zcodeCallTool(cfg, {
    spawn: (cmd, args, opts) => {
      spawnCount++
      lastSpawn = { cmd, args, cwd: opts && opts.cwd, env: opts && opts.env }
      return fakeZcodeChild({
        sessionId: 'sess-mock-1',
        traceId: 'trace-mock-1',
        response: 'MOCKED-OK',
        usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
        projection: { contextWindow: 200000, contextUsed: 100 },
      })
    },
  })
}

const SIG = () => ({ signal: new AbortController().signal })

console.log('dsh-zcode-coding-plan · registration tests\n')

// ── 1. plugin contract ──
console.log('[1] DSH 插件契约')
check('export name', mod.name === 'dsh-zcode-coding-plan', String(mod.name))
check('inject = [tools]', Array.isArray(mod.inject) && mod.inject[0] === 'tools', JSON.stringify(mod.inject))
check('export apply is a function', typeof mod.apply === 'function')

// ── 2. registration ──
console.log('\n[2] 工具注册')
{
  const { registered, ctx } = mockCtx()
  mod.apply(ctx, {})
  check('two tools registered', registered.length === 2, `got ${registered.length}`)
  check('zcode_call present', registered.some((t) => t.name === 'zcode_call'))
  check('zcode_quota present', registered.some((t) => t.name === 'zcode_quota'))

  const call = registered.find((t) => t.name === 'zcode_call')
  const quota = registered.find((t) => t.name === 'zcode_quota')

  // zcode_call schema
  check('zcode_call has parameters', !!call.parameters)
  check('prompt required', call.parameters.required.includes('prompt'))
  check('mode enum', JSON.stringify(call.parameters.properties.mode.enum) ===
    JSON.stringify(['build', 'edit', 'plan', 'yolo']))
  check('force property present', 'force' in call.parameters.properties)
  check('resume property present', 'resume' in call.parameters.properties)
  check('timeoutMs set', typeof call.timeoutMs === 'number' && call.timeoutMs > 0, String(call.timeoutMs))
  check('isConcurrencySafe false', call.isConcurrencySafe() === false)
  check('output.schema present', !!call.output && !!call.output.schema)
  check('execute is async fn', typeof call.execute === 'function')
  check('output.render present', typeof call.output.render === 'function')

  // zcode_quota schema
  check('zcode_quota concurrency safe', quota.isConcurrencySafe() === true)
  check('zcode_quota render present', typeof quota.output.render === 'function')
}

// ── 3. input validation (no spawn) ──
console.log('\n[3] 参数校验（不 spawn）')
{
  const call = mockCallTool()

  const empty = await call.execute({ prompt: '   ' }, SIG())
  check('empty prompt rejected', empty && empty.error === 'prompt 不能为空', JSON.stringify(empty))
  check('empty prompt did not spawn', spawnCount === 0)

  const badCwd = await call.execute({ prompt: 'hi', cwd: 'C:/definitely/not/here/xyz' }, SIG())
  check('missing cwd rejected', badCwd && String(badCwd.error).startsWith('cwd 不存在'), JSON.stringify(badCwd))
  check('missing cwd did not spawn', spawnCount === 0)
}

// ── 4. cwd resolution + argv/env contract ──
console.log('\n[4] cwd 解析与 argv/env 契约')
{
  const call = mockCallTool()
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-zcode-test-'))

  const r1 = await call.execute({ prompt: 'hi', cwd: tmp }, SIG())
  check('absolute cwd accepted', r1 && r1.response === 'MOCKED-OK', JSON.stringify(r1))
  check('cwd passed to child', lastSpawn.cwd === tmp, String(lastSpawn.cwd))
  check('argv[0] is zcode.cjs', String(lastSpawn.args[0]).replace(/\\/g, '/').endsWith('resources/glm/zcode.cjs'),
    String(lastSpawn.args[0]))
  check('argv has --mode yolo --json',
    lastSpawn.args[1] === '--mode' && lastSpawn.args[2] === 'yolo' && lastSpawn.args[3] === '--json',
    JSON.stringify(lastSpawn.args))
  check('argv ends with -p <prompt>',
    lastSpawn.args[4] === '-p' && lastSpawn.args[5] === 'hi', JSON.stringify(lastSpawn.args))
  check('no --resume when not resuming', !lastSpawn.args.includes('--resume'))
  check('ELECTRON_RUN_AS_NODE=1', lastSpawn.env.ELECTRON_RUN_AS_NODE === '1')
  check('ZCODE_PERSONAL_PROVIDER_CONFIG_FILE set',
    typeof lastSpawn.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE === 'string' &&
    lastSpawn.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE.endsWith('.json'),
    String(lastSpawn.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE))

  // explicit mode + resume
  await call.execute({ prompt: 'second', cwd: tmp, mode: 'plan', resume: 'sess-mock-1' }, SIG())
  check('mode=plan honoured', lastSpawn.args.includes('plan'))
  check('--resume inserted', lastSpawn.args.includes('--resume') && lastSpawn.args.includes('sess-mock-1'),
    JSON.stringify(lastSpawn.args))

  // relative cwd resolved against session cwd ("." = the session dir itself)
  const rel = await call.execute(
    { prompt: 'hi', cwd: '.' },
    { signal: new AbortController().signal, agent: { session: { header: { cwd: tmp } } } },
  )
  check('relative cwd resolves against session cwd',
    rel && !String(rel.error || '').startsWith('cwd 不存在'), JSON.stringify(rel))
  check('relative cwd landed on session dir', lastSpawn.cwd === tmp, String(lastSpawn.cwd))
}

// ── 5. session cwd from exec context ──
console.log('\n[5] 会话 cwd 解析')
{
  const call = mockCallTool()
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-zcode-sess-'))
  const r = await call.execute({ prompt: 'hi' }, {
    signal: new AbortController().signal,
    agent: { session: { header: { cwd: tmp } } },
  })
  check('uses exec.agent.session.header.cwd when cwd omitted',
    r && !String(r.error || '').startsWith('cwd 不存在'), JSON.stringify(r))
  check('session cwd handed to child', lastSpawn.cwd === tmp, String(lastSpawn.cwd))
}

// ── 5b. timeout clamp + failure rendering ──
console.log('\n[5b] 超时钳制与错误渲染')
{
  const call = mockCallTool({ minTimeoutMs: 30000, maxTimeoutMs: 3600000, defaultTimeoutMs: 900000 })
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-zcode-timeout-'))
  // timeout_ms=1 must clamp up to 30000; the mocked child closes immediately so
  // we only assert the call still succeeds and the env/argv is well-formed.
  const r = await call.execute({ prompt: 'x', cwd: tmp, timeout_ms: 1 }, SIG())
  check('timeout_ms below min still executes (clamped)', r && r.response === 'MOCKED-OK', JSON.stringify(r))

  const { cfg } = mod.resolveConfig({ minTimeoutMs: 30000, maxTimeoutMs: 3600000, defaultTimeoutMs: 900000 })
  check('defaultTimeoutMs >= minTimeoutMs', cfg.defaultTimeoutMs >= cfg.minTimeoutMs,
    `${cfg.defaultTimeoutMs} vs ${cfg.minTimeoutMs}`)
  check('maxTimeoutMs >= defaultTimeoutMs', cfg.maxTimeoutMs >= cfg.defaultTimeoutMs,
    `${cfg.maxTimeoutMs} vs ${cfg.defaultTimeoutMs}`)

  const good = {
    sessionId: 's', response: 'hi',
    usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    projection: { contextWindow: 200000, contextUsed: 10 },
  }
  const rendered = call.output.render({}, good)
  check('render shows sessionId', rendered[0].text.includes('s'))
  check('render shows response', rendered[0].text.includes('hi'))
  check('render shows usage', rendered[0].text.includes('usage:'))
  check('render shows context', rendered[0].text.includes('context:'))
  const errRendered = call.output.render({}, { error: 'boom', hint: 'do this', exitCode: 3 })
  check('render shows error', errRendered[0].text.includes('boom'))
  check('render shows hint', errRendered[0].text.includes('do this'))
}

// ── 6. extractFirstJsonObject ──
console.log('\n[6] stdout JSON 提取')
{
  check('extracts plain object', mod.extractFirstJsonObject('{"a":1}')?.a === 1)
  check('skips noise before object', mod.extractFirstJsonObject('loading...\n{"a":2}\n')?.a === 2)
  check('handles nested', mod.extractFirstJsonObject('{"a":{"b":[1,2]}}')?.a?.b?.length === 2)
  check('handles braces in strings', mod.extractFirstJsonObject('{"a":"}{"}')?.a === '}{')
  check('handles escaped quotes', mod.extractFirstJsonObject('{"a":"say \\"hi\\""}')?.a === 'say "hi"')
  check('returns undefined on garbage', mod.extractFirstJsonObject('no json here') === undefined)
  check('returns undefined on empty', mod.extractFirstJsonObject('') === undefined)
  check('returns undefined on truncated', mod.extractFirstJsonObject('{"a":1') === undefined)
}

// ── 7. paths module ──
console.log('\n[7] 路径探测')
{
  const found = findZCodeRoot({})
  check('findZCodeRoot returns an object', typeof found === 'object')
  if (found.root) {
    // A legitimately discovered root is fine (this machine really does have
    // ZCode on D:). What must never happen is a root that doesn't exist.
    check('discovered root exists on disk', existsSync(found.root), found.root)
    console.log(`    本机探测结果: ${found.root} (${found.source})`)
  } else {
    console.log(`    本机未装 ZCode（这是合法状态）：source=${found.source}`)
  }

  const resolved = resolveZCodePaths({}, {})
  check('resolveZCodePaths returns ok|error', typeof resolved.ok === 'boolean')
  // De-pathing guarantee: the old build had these as DEFAULTS. A machine that
  // legitimately installed ZCode to D:\Program Files\ZCode may still resolve
  // there — what must not happen is resolving there WITHOUT it existing.
  check('resolved exe actually exists on disk', existsSync(resolved.zcodeExe || ''))
  check('resolved cjs actually exists on disk', existsSync(resolved.zcodeCjs || ''))
  check('exe is never invented when probe fails',
    resolveZCodePaths({ zcodeRoot: '/definitely/not/a/zcode/install' }, { env: { PATH: '' } }).ok === false)

  check('defaultOverridePath ends with .json', defaultOverridePath({}).endsWith('.json'))
  check('defaultOverridePath honours DSH_HOME',
    defaultOverridePath({ DSH_HOME: '/custom/dsh' }).includes('custom'),
    defaultOverridePath({ DSH_HOME: '/custom/dsh' }))
  check('defaultOverridePath honours DSH_ZCODE_OVERRIDE',
    defaultOverridePath({ DSH_ZCODE_OVERRIDE: '/tmp/o.json' }).endsWith('o.json'),
    defaultOverridePath({ DSH_ZCODE_OVERRIDE: '/tmp/o.json' }))
  check('credentialsPath ends with .credentials.yaml',
    credentialsPath({ USERPROFILE: 'C:\\Users\\x' }).endsWith('.credentials.yaml'))
}

// ── 8. override module ──
console.log('\n[8] 覆盖配置与凭据')
{
  const doc = buildOverrideConfig({ apiKey: 'test-key' })
  check('providerOrder[0] is the coding plan provider',
    doc.config.providerOrder[0] === 'dsh-glm-coding-plan', JSON.stringify(doc.config.providerOrder))
  const rule = doc.config.providerConfigRules.providerRules[0]
  check('providerId matches providerOrder[0]', rule.providerId === doc.config.providerOrder[0])
  check('apiKey embedded', rule.config.access.apiKey === 'test-key')
  check('baseUrl is the anthropic endpoint',
    rule.config.api.baseUrl === 'https://open.bigmodel.cn/api/anthropic')
  check('modelOrder present', rule.config.modelOrder.length > 0)
  check('modelConfigRules cover each model',
    doc.config.modelConfigRules.providerModelRules.length === rule.config.modelOrder.length)
  check('no defaultModelSelection (known ineffective)',
    doc.config.defaultModelSelection === undefined)

  const key = loadCodingPlanKey()
  if (key) console.log(`    读到本机 ${'BIGMODEL_CODING_PLAN_API_KEY'} (len ${key.length})`)
  else console.log('    本机未配置套餐 Key（合法状态）')

  const ov = defaultOverridePath()
  if (overrideLooksValid(ov)) console.log(`    本机覆盖配置有效: ${ov}`)
  else console.log(`    本机覆盖配置: ${ov} (${existsSync(ov) ? '存在但内容不符' : '不存在'})`)
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${pass} passed, ${fail} failed`)
if (fail) {
  console.log('failed:', failures.join(', '))
  process.exit(1)
}