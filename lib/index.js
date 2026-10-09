// dsh-zcode-coding-plan — DeepSeek Harness desktop plugin.
//
// Lets desktop agents call GLM Coding Plan models through the OFFICIAL ZCode
// CLI, so a paid coding-plan subscription actually gets used from DSH. The
// ZCode channel is billed at 1.5x (150%) plan credits per the official docs;
// hitting open.bigmodel.cn/api/anthropic directly with the same key is billed
// against account balance instead.
//
// Mechanism (verified on Windows, ZCode 3.14.5):
//   <ZCode.exe> <resources/glm/zcode.cjs> --mode <mode> --json
//              -p "<prompt>" [--resume <sessionId>]
//   env: ELECTRON_RUN_AS_NODE=1
//        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=<our override json>
//        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=<ZCode builtin provider json>
//   stdout carries one JSON object:
//     { sessionId, traceId, turnId, response,
//       usage: { inputTokens, outputTokens, totalTokens },
//       projection: { contextWindow, contextUsed } }
//   stderr is noisy — never parsed.
//
// ZCode picks the provider as "the first enabled entry in providerOrder", so
// putting our coding-plan provider at index 0 is what routes the request. (A
// `defaultModelSelection` field does NOT work — tested, ignored.)
//
// This plugin NEVER writes the ZCode desktop provider registry or
// ~/.zcode/v2/credentials.json; the override is injected per spawn via env.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import {
  ZCODE_INSTALL_DOC,
  credentialsPath,
  defaultOverridePath,
  resolveZCodePaths,
} from './paths.js'
import { QUOTA_DEFAULTS, createQuotaChecker, gateVerdict, renderQuota } from './quota.js'
import { buildOverrideConfig, loadCodingPlanKey } from './override.js'

export const name = 'dsh-zcode-coding-plan'
export const inject = ['tools']

export const MODES = ['build', 'edit', 'plan', 'yolo']

export const DEFAULTS = {
  providerId: 'dsh-glm-coding-plan',
  baseUrl: 'https://open.bigmodel.cn/api/anthropic',
  modelIds: ['GLM-5.3-Flash', 'GLM-5.3'],
  contextWindow: 200000,
  defaultMode: 'yolo',
  defaultTimeoutMs: 900000,
  minTimeoutMs: 30000,
  maxTimeoutMs: 3600000,
  maxStdoutBytes: 16 * 1024 * 1024,
  maxStderrBytes: 16384,
  ...QUOTA_DEFAULTS,
}

const clamp = (v, d, min, max) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
}

/**
 * Extract the first complete, parseable JSON object from mixed CLI stdout.
 * Scan forward from each '{', tracking string/escape state and brace depth;
 * the first candidate that closes at depth 0 AND parses wins. Returns
 * undefined when stdout holds no full object (timeout / crash / empty).
 */
export function extractFirstJsonObject(text) {
  if (!text) return undefined
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          const candidate = text.slice(start, i + 1)
          try {
            const value = JSON.parse(candidate)
            if (value && typeof value === 'object') return value
          } catch {
            break // not a JSON object start; try the next '{'
          }
        }
      }
    }
  }
  return undefined
}

/** Windows needs taskkill /T /F to reap grandchildren; elsewhere SIGKILL. */
export function killTree(child) {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {
      try { child.kill() } catch { /* already gone */ }
    }
  } else {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
}

function truncateTail(buf, max) {
  if (buf.length <= max) return buf.toString('utf8')
  return '…' + buf.subarray(buf.length - max).toString('utf8')
}

function buildEnv(cfg) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: cfg.providerOverride,
  }
  // Optional: without the builtin json ZCode falls back to its own default,
  // which would let a different provider win providerOrder[0].
  if (cfg.builtinProviderConfig) {
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = cfg.builtinProviderConfig
  }
  return env
}

/**
 * Resolve the full runtime config: probe ZCode, then make sure an override
 * json exists. Never throws — problems come back as `problems` so the tools
 * can explain them instead of dying at load time.
 */
export function resolveConfig(config = {}, env = process.env) {
  const cfg = { ...DEFAULTS, ...(config || {}) }

  if (!MODES.includes(cfg.defaultMode)) cfg.defaultMode = DEFAULTS.defaultMode
  cfg.defaultTimeoutMs = clamp(
    cfg.defaultTimeoutMs, DEFAULTS.defaultTimeoutMs, DEFAULTS.minTimeoutMs, DEFAULTS.maxTimeoutMs,
  )
  cfg.maxTimeoutMs = clamp(cfg.maxTimeoutMs, DEFAULTS.maxTimeoutMs, cfg.defaultTimeoutMs, 4 * 3600000)
  for (const key of ['quotaRouteWindowPct', 'quotaRouteWeekPct']) {
    const n = Number(cfg[key])
    cfg[key] = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : DEFAULTS[key]
  }

  cfg.providerOverride = cfg.providerOverride || defaultOverridePath(env)

  const problems = []
  const paths = resolveZCodePaths(cfg, { env })
  cfg.zcodeRoot = paths.root
  cfg.zcodeExe = paths.zcodeExe
  cfg.zcodeCjs = paths.zcodeCjs
  cfg.builtinProviderConfig = paths.builtinProviderConfig
  cfg.probeSource = paths.source
  if (!paths.ok) problems.push(paths.error)

  // Auto-create the override on first run so a fresh install works with just
  // the credentials file present.
  if (!existsSync(cfg.providerOverride)) {
    const key = loadCodingPlanKey(env)
    if (key) {
      try {
        mkdirSync(dirname(cfg.providerOverride), { recursive: true })
        const built = buildOverrideConfig({
          apiKey: key,
          ...cfg,
          builtinProviderConfig: cfg.builtinProviderConfig,
        })
        for (const note of built.notes || []) {
          console.log(`[dsh-zcode-coding-plan] ${note}`)
        }
        writeFileSync(
          cfg.providerOverride,
          JSON.stringify(built.doc, null, 2),
          { encoding: 'utf8' },
        )
        cfg.generatedOverride = true
      } catch (err) {
        problems.push(`provider 覆盖配置自动生成失败: ${err && err.message}`)
      }
    } else {
      problems.push(
        `找不到 GLM Coding Plan 套餐 Key：${credentialsPath(env)} 里没有 BIGMODEL_CODING_PLAN_API_KEY。` +
        '请先在智谱开通 GLM Coding Plan，把 Key 填进该文件的 refs 段（示例：\n' +
        '  BIGMODEL_CODING_PLAN_API_KEY: 你的套餐Key\n' +
        '），或运行 `node scripts/install.mjs` 生成覆盖配置。',
      )
    }
  }
  if (!existsSync(cfg.providerOverride) && !problems.length) {
    problems.push(`provider 覆盖配置不存在: ${cfg.providerOverride}`)
  }

  return { cfg, problems }
}

function renderResult(value) {
  if (value && value.error) {
    const lines = [`zcode_call 失败: ${value.error}`]
    if (value.hint) lines.push(value.hint)
    if (value.timedOut) lines.push(`原因: 子进程超过 ${value.timeoutMs}ms 被终止（可调大 timeout_ms 或精简任务）`)
    if (value.exitCode !== undefined) lines.push(`exitCode: ${value.exitCode}`)
    if (value.stderrTail) lines.push(`stderr 尾部:\n${value.stderrTail}`)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const lines = []
  if (value && value.sessionId) lines.push(`sessionId: ${value.sessionId}（多轮续接请把它传给 resume 参数）`)
  lines.push('response:')
  lines.push(value && typeof value.response === 'string' && value.response.length ? value.response : '(空回复)')
  if (value && value.usage) {
    const u = value.usage
    lines.push(`usage: input=${u.inputTokens} output=${u.outputTokens} total=${u.totalTokens}`)
  }
  if (value && value.projection) {
    const p = value.projection
    lines.push(`context: ${p.contextUsed}/${p.contextWindow} tokens`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

export function zcodeCallTool(cfg, deps = {}) {
  const spawnFn = deps.spawn || spawn
  const quota = createQuotaChecker(cfg, deps.quotaDeps)
  return {
    name: 'zcode_call',
    description:
      '通过 ZCode 官方 CLI 调用 GLM Coding Plan 模型（智谱套餐额度，ZCode 渠道 1.5 倍用量），' +
      '执行一次真实 agent 任务：可读写 cwd 内文件、跑命令。适用于用户要求"用 zcode/coding plan 干活"、"省 DSH 额度"、' +
      '或重活外包。单轮耗时 20 秒～几分钟（每次请求约 66K tokens 系统提示）。' +
      '返回 {sessionId, response, usage, projection}；取 response 向用户汇报，' +
      '多轮把 sessionId 传入 resume。仅咨询不动文件用 mode=plan。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: '派给 GLM 的任务提示词，写清目标与验收标准' },
        cwd: { type: 'string', description: '任务工作目录（绝对路径，或相对会话目录）；省略=当前会话工作目录' },
        resume: { type: 'string', description: '上一次返回的 sessionId，续接多轮会话' },
        mode: { type: 'string', enum: MODES, description: 'build/edit/plan/yolo；默认 yolo（全自动）。plan 只讨论不动文件' },
        timeout_ms: { type: 'number', description: '子进程超时毫秒，默认 900000（15 分钟），上限 3600000' },
        force: { type: 'boolean', description: 'true 时跳过余量闸门强行执行（默认 false：套餐余量不足会拒绝并返回 quota_insufficient）' },
      },
      required: ['prompt'],
    },
    // Outer cooperative budget must never fire before the tool's own child
    // timeout (timeout_ms, clamped to maxTimeoutMs) — the child process kill
    // IS the graceful path; this is just the policy backstop.
    timeoutMs: cfg.maxTimeoutMs,
    // Spawns a heavy child process (~15 plan credits per request); parallel
    // fan-out would double-bill and thrash the machine. Stay exclusive.
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          sessionId: { type: 'string' },
          traceId: { type: 'string' },
          response: { type: 'string' },
          usage: {
            type: 'object',
            additionalProperties: true,
            properties: {
              inputTokens: { type: 'number' },
              outputTokens: { type: 'number' },
              totalTokens: { type: 'number' },
            },
          },
          projection: {
            type: 'object',
            additionalProperties: true,
            properties: {
              contextWindow: { type: 'number' },
              contextUsed: { type: 'number' },
            },
          },
          exitCode: { type: 'number' },
          error: { type: 'string' },
          hint: { type: 'string' },
          timedOut: { type: 'boolean' },
          timeoutMs: { type: 'number' },
          stderrTail: { type: 'string' },
        },
      },
      render: (_args, value) => renderResult(value),
    },
    async execute(args, exec) {
      const a = args || {}
      const prompt = typeof a.prompt === 'string' ? a.prompt : ''
      if (!prompt.trim()) return { error: 'prompt 不能为空' }

      const mode = MODES.includes(a.mode) ? a.mode : cfg.defaultMode
      const timeoutMs = clamp(a.timeout_ms, cfg.defaultTimeoutMs, cfg.minTimeoutMs, cfg.maxTimeoutMs)
      const resume = typeof a.resume === 'string' && a.resume.trim() ? a.resume.trim() : undefined

      // cwd: explicit arg (absolute, or session-cwd-relative) > session cwd > process cwd
      const headerCwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
        ? exec.agent.session.header.cwd
        : undefined
      const sessionCwd = headerCwd ? resolve(headerCwd) : process.cwd()
      let cwd = sessionCwd
      if (typeof a.cwd === 'string' && a.cwd.trim()) {
        cwd = isAbsolute(a.cwd.trim()) ? resolve(a.cwd.trim()) : resolve(sessionCwd, a.cwd.trim())
      }
      if (!existsSync(cwd)) return { error: `cwd 不存在: ${cwd}` }

      if (!cfg.zcodeExe || !existsSync(cfg.zcodeExe)) {
        return {
          error: `未找到 ZCode 可执行文件（探测结果: ${cfg.zcodeExe || '无'}）。${ZCODE_INSTALL_DOC}`,
          hint: '安装 ZCode，或在 cordis.patch.yml 的 config 里显式指定 zcodeExe / zcodeCjs。',
        }
      }
      if (!cfg.zcodeCjs || !existsSync(cfg.zcodeCjs)) {
        return { error: `未找到 zcode.cjs（探测结果: ${cfg.zcodeCjs || '无'}）`, hint: `安装 ZCode：${ZCODE_INSTALL_DOC}` }
      }
      if (!cfg.providerOverride || !existsSync(cfg.providerOverride)) {
        return {
          error: `provider 覆盖配置不存在: ${cfg.providerOverride}`,
          hint: '运行 `node scripts/generate-override.mjs` 生成（需要 ~/.dsh/.credentials.yaml 里的套餐 Key）。',
        }
      }

      // Quota gate: auto-route only when the coding plan has headroom.
      // Fail-open when the check itself is unavailable; force bypasses.
      const q = await quota.check({ force: a.force })
      const verdict = gateVerdict(q, a.force)
      if (verdict) return verdict

      const argv = [cfg.zcodeCjs, '--mode', mode, '--json']
      if (resume) argv.push('--resume', resume)
      argv.push('-p', prompt)

      const child = spawnFn(cfg.zcodeExe, argv, {
        cwd,
        env: buildEnv(cfg),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const stdoutChunks = []
      let stdoutBytes = 0
      let stdoutTruncated = false
      const stderrChunks = []
      let stderrBytes = 0
      let timedOut = false
      let exitCode
      let settled = false

      return await new Promise((settle) => {
        let timer
        const onAbort = () => {
          if (settled) return
          killTree(child)
        }
        const finish = (value) => {
          if (settled) return
          settled = true
          if (timer) clearTimeout(timer)
          if (exec && exec.signal) exec.signal.removeEventListener('abort', onAbort)
          settle(value)
        }

        if (exec && exec.signal) {
          if (exec.signal.aborted) onAbort()
          else exec.signal.addEventListener('abort', onAbort, { once: true })
        }

        timer = setTimeout(() => {
          timedOut = true
          killTree(child)
        }, timeoutMs)

        child.on('error', (err) => {
          finish({
            error: `spawn 失败: ${err && err.message ? err.message : String(err)}`,
            timedOut,
            timeoutMs,
          })
        })

        child.stdout.on('data', (chunk) => {
          if (stdoutBytes >= cfg.maxStdoutBytes) {
            stdoutTruncated = true
            return
          }
          stdoutBytes += chunk.length
          if (stdoutBytes >= cfg.maxStdoutBytes) {
            stdoutTruncated = true
            stdoutChunks.push(chunk.subarray(0, chunk.length - (stdoutBytes - cfg.maxStdoutBytes)))
            return
          }
          stdoutChunks.push(chunk)
        })
        child.stderr.on('data', (chunk) => {
          if (stderrBytes >= cfg.maxStderrBytes) return
          stderrBytes += chunk.length
          stderrChunks.push(chunk)
          if (stderrBytes > cfg.maxStderrBytes) {
            // keep only the tail
            let merged = Buffer.concat(stderrChunks)
            merged = merged.subarray(merged.length - cfg.maxStderrBytes)
            stderrChunks.length = 0
            stderrChunks.push(merged)
          }
        })

        child.on('close', (code) => {
          exitCode = code
          const stdoutText = Buffer.concat(stdoutChunks).toString('utf8')
          const parsed = extractFirstJsonObject(stdoutText)
          if (exec && exec.signal && exec.signal.aborted && !parsed) {
            finish({ error: '调用已被取消（abort）', timedOut, timeoutMs })
            return
          }
          if (!parsed) {
            finish({
              error: timedOut
                ? `子进程超过 ${timeoutMs}ms 未返回结果，已终止（可调大 timeout_ms 或精简任务）`
                : `ZCode CLI 未输出可解析的 JSON（exitCode=${code}${stdoutTruncated ? ', stdout 超长被截断' : ''}）`,
              timedOut,
              timeoutMs,
              exitCode: code,
              stderrTail: truncateTail(Buffer.concat(stderrChunks), cfg.maxStderrBytes),
            })
            return
          }
          finish({
            sessionId: parsed.sessionId,
            traceId: parsed.traceId,
            response: parsed.response,
            usage: parsed.usage,
            projection: parsed.projection,
            exitCode: code,
          })
        })
      })
    },
  }
}

export function zcodeQuotaTool(cfg, deps = {}) {
  const quota = createQuotaChecker(cfg, deps.quotaDeps)
  return {
    name: 'zcode_quota',
    description:
      '查询 GLM Coding Plan 套餐余量（需要本地余量估算脚本；未配置时返回 available=false，闸门自动跳过）。' +
      '派发编码重活前先调用它：sufficient=true 直接 zcode_call 派活；false 则本地自己做并告知用户余量。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    isConcurrencySafe: () => true,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderQuota(value),
    },
    async execute() {
      return await quota.check()
    },
  }
}

export function apply(ctx, config) {
  // Plugin-level config from cordis.patch.yml (config row), merged over defaults.
  // Probing happens at load so env/config problems surface in the log instead
  // of as a confusing tool error on first use.
  const { cfg, problems } = resolveConfig(config)
  const line = [
    '[dsh-zcode-coding-plan] tools zcode_call + zcode_quota registered;',
    `zcode=${cfg.zcodeExe || '(未找到)'}`,
    `cjs=${cfg.zcodeCjs || '(未找到)'}`,
    `override=${cfg.providerOverride}${cfg.generatedOverride ? ' (auto-generated)' : ''}`,
    `probe=${cfg.probeSource}`,
  ].join(' ')
  console.log(line)
  for (const p of problems) console.warn(`[dsh-zcode-coding-plan] ⚠ ${p}`)

  // Each tool gets its own checker so the quota TTL cache is shared per tool
  // instance but not leaked between a re-registered pair.
  ctx.tools.register(zcodeCallTool(cfg))
  ctx.tools.register(zcodeQuotaTool(cfg))
}