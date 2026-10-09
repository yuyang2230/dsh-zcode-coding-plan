// lib/paths.js — cross-platform ZCode discovery + DSH user-config locations.
//
// Zero hard-coded machine paths live here. Resolution order for every ZCode
// artifact (executable, resources/glm/zcode.cjs, builtin provider json):
//
//   1. explicit plugin config (cordis.patch.yml `config:` row)
//   2. ZCODE_HOME environment variable (or its platform equivalent)
//   3. platform probing: Windows registry Uninstall entries → well-known
//      install dirs → PATH; macOS /Applications bundles; Linux PATH + /opt
//
// If nothing matches we return a structured error carrying the official
// install URL — never a guess-and-hope fallback path.
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'

export const ZCODE_INSTALL_DOC = 'https://zcode.z.ai/cn/docs/install'

/** Relative layout of a ZCode desktop install. */
const REL = {
  exe: ['ZCode.exe', 'zcode', 'ZCode'],
  cjs: ['resources', 'glm', 'zcode.cjs'],
  builtin: ['resources', 'config', 'provider', 'zcode-builtin.json'],
}

const isFile = (p) => {
  try {
    return !!p && existsSync(p)
  } catch {
    return false
  }
}

const isDir = (p) => {
  try {
    return !!p && existsSync(p)
  } catch {
    return false
  }
}

/**
 * Locate the root directory of a ZCode install, or undefined.
 * Accepts both the Electron app bundle (macOS) and the install dir (win/linux).
 */
function looksLikeInstallRoot(dir) {
  if (!isDir(dir)) return false
  for (const name of REL.exe) if (isFile(join(dir, name))) return true
  if (isFile(join(dir, ...REL.cjs))) return true
  // macOS: /Applications/ZCode.app — resources live one level deeper
  if (isFile(join(dir, 'Contents', 'Resources', 'glm', 'zcode.cjs'))) return true
  if (isFile(join(dir, 'resources', 'app.asar'))) return true
  return false
}

// ── Windows ───────────────────────────────────────────────────────────────

/**
 * Read the Windows Uninstall registry for ZCode install roots.
 * NOTE: verified on ZCode 3.14.5 — the entry has NO `InstallLocation` value,
 * so the root is derived by stripping `Uninstall ZCode.exe /allusers` off
 * `UninstallString`. Both HKLM (all-users, the common case) and HKCU are
 * scanned; `Wow6432Node` is included so 32-bit installs on x64 are found.
 */
function probeWindowsRegistry() {
  if (process.platform !== 'win32') return []
  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  const found = []
  for (const hive of roots) {
    let text = ''
    try {
      text = execFileSync('reg', ['query', hive, '/s'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15000,
      })
    } catch {
      continue // key missing / access denied — try the next hive
    }
    const blocks = text.split(/\r?\n\r?\n/)
    for (const block of blocks) {
      if (!/\bZCode\b/i.test(block)) continue
      const dir = dirFromUninstallString(block) || valueAfter(block, 'InstallLocation')
      if (dir && looksLikeInstallRoot(dir)) found.push(dir)
    }
  }
  return dedupe(found)
}

function valueAfter(block, key) {
  const re = new RegExp(`^\\s*${key}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+)$`, 'im')
  const m = block.match(re)
  return m ? m[1].trim() : undefined
}

function dirFromUninstallString(block) {
  const raw = valueAfter(block, 'UninstallString') || valueAfter(block, 'QuietUninstallString')
  if (!raw) return undefined
  const quoted = raw.match(/"([^"]+)"/)
  const exe = quoted ? quoted[1] : raw.split(/\s+/)[0]
  const dir = dirname(exe)
  return looksLikeInstallRoot(dir) ? dir : undefined
}

// ── platform candidates ───────────────────────────────────────────────────

function windowsCandidates(env) {
  const local = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs') : undefined
  const programFiles = env.ProgramFiles
  const programFilesX86 = env['ProgramFiles(x86)']
  const cands = []
  if (env.ZCODE_HOME) cands.push(env.ZCODE_HOME)
  if (local) cands.push(join(local, 'ZCode'))
  for (const base of [programFiles, programFilesX86]) {
    if (base) cands.push(join(base, 'ZCode'))
  }
  // Common non-default roots seen on Chinese dev boxes (D:\Program Files\…),
  // both drive letters — still generic, not a single machine's path.
  for (const drive of ['D:', 'E:']) {
    cands.push(`${drive}\\Program Files\\ZCode`)
    cands.push(`${drive}\\ZCode`)
  }
  return cands
}

function macCandidates(env) {
  const home = env.HOME || homedir()
  const cands = []
  if (env.ZCODE_HOME) cands.push(env.ZCODE_HOME)
  if (home) {
    cands.push('/Applications/ZCode.app')
    cands.push(join(home, 'Applications', 'ZCode.app'))
  }
  return cands
}

function linuxCandidates(env) {
  const cands = []
  if (env.ZCODE_HOME) cands.push(env.ZCODE_HOME)
  cands.push('/opt/ZCode', '/usr/lib/zcode', '/usr/share/zcode')
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (dir) cands.push(join(dir, 'ZCode'), join(dir, 'zcode'))
  }
  return cands
}

/** PATH lookup that works for both `zcode` shims and bare names. */
function probeWhich(env) {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  for (const name of ['zcode', 'ZCode', 'zcode-cli']) {
    try {
      const out = execFileSync(cmd, [name], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 8000,
      })
      const first = String(out).split(/\r?\n/).map((s) => s.trim()).find(Boolean)
      if (first && isFile(first)) return first
    } catch {
      /* not on PATH */
    }
  }
  return undefined
}

const dedupe = (arr) => [...new Set(arr.filter(Boolean))]

/**
 * Find the ZCode install root.
 * @returns {{root?: string, source: string, tried: string[]}}
 */
export function findZCodeRoot(options = {}) {
  const env = options.env || process.env
  const tried = []
  const push = (list) => {
    for (const c of list) {
      if (!c) continue
      const norm = normalizeRoot(c)
      tried.push(norm)
      if (looksLikeInstallRoot(norm)) return norm
    }
    return undefined
  }

  if (options.root) return { root: normalizeRoot(options.root), source: 'config', tried }

  const home = env.HOME || homedir()
  if (env.ZCODE_HOME) {
    const r = normalizeRoot(env.ZCODE_HOME)
    tried.push(r)
    if (looksLikeInstallRoot(r)) return { root: r, source: 'ZCODE_HOME', tried }
    // ZCODE_HOME may point at the binary or the bundle contents instead
    const parent = dirname(r)
    if (looksLikeInstallRoot(parent)) return { root: parent, source: 'ZCODE_HOME(parent)', tried }
  }

  let hit
  if (process.platform === 'win32') {
    hit = push(windowsCandidates(env))
    if (hit) return { root: hit, source: 'windows-paths', tried }
    hit = probeWindowsRegistry()[0]
    if (hit) return { root: hit, source: 'windows-registry', tried }
  } else if (process.platform === 'darwin') {
    hit = push(macCandidates(env))
    if (hit) return { root: hit, source: 'macos-paths', tried }
    hit = firstDirIn(['/Applications', home ? join(home, 'Applications') : ''].filter(Boolean))
    if (hit) return { root: hit, source: 'macos-scan', tried }
  } else {
    hit = push(linuxCandidates(env))
    if (hit) return { root: hit, source: 'linux-paths', tried }
  }

  const which = probeWhich(env)
  if (which) {
    const root = dirname(which)
    if (looksLikeInstallRoot(root)) return { root, source: 'PATH', tried }
  }

  return { source: 'not-found', tried: dedupe(tried) }
}

function firstDirIn(dirs) {
  for (const d of dirs) {
    try {
      for (const name of readdirSync(d)) {
        if (/^zcode/i.test(name)) {
          const p = join(d, name)
          if (looksLikeInstallRoot(p)) return p
        }
      }
    } catch {
      /* unreadable dir */
    }
  }
  return undefined
}

/** macOS bundles need Contents/Resources; strip a trailing MacOS dir. */
function normalizeRoot(p) {
  let r = resolve(String(p))
  if (process.platform === 'darwin' && /\/Contents\/Resources$/.test(r)) {
    r = r.slice(0, -'/Contents/Resources'.length)
  }
  if (process.platform === 'darwin' && /\/Contents\/MacOS$/.test(r)) {
    r = r.slice(0, -'/Contents/MacOS'.length)
  }
  return r
}

const derive = (root, rel) => {
  if (!root) return undefined
  if (process.platform === 'darwin' && root.endsWith('.app')) {
    const mac = join(root, 'Contents', 'Resources', ...rel)
    if (isFile(mac)) return mac
  }
  const p = join(root, ...rel)
  return isFile(p) ? p : p // return the expected path anyway; caller checks
}

function findExecutable(root) {
  for (const name of REL.exe) {
    const p = join(root, name)
    if (isFile(p)) return p
  }
  if (process.platform === 'darwin') {
    const p = join(root, 'Contents', 'MacOS', 'ZCode')
    if (isFile(p)) return p
  }
  try {
    for (const name of readdirSync(root)) {
      if (/^zcode/i.test(name) && isFile(join(root, name))) return join(root, name)
    }
  } catch {
    /* unreadable */
  }
  return join(root, REL.exe[0])
}

/**
 * Resolve every artifact the plugin needs.
 *
 * @param {object} config  plugin config (may override each field)
 * @param {object} [opts]  { env } for testability
 * @returns {{
 *   ok: boolean,
 *   zcodeExe?: string, zcodeCjs?: string, builtinProviderConfig?: string,
 *   root?: string, source?: string,
 *   missing?: Array<{what: string, path?: string}>,
 *   error?: string, hint?: string, tried?: string[]
 * }}
 */
export function resolveZCodePaths(config = {}, opts = {}) {
  const env = opts.env || process.env
  const out = { ok: false, missing: [], tried: [] }

  // Explicit config wins, but we still validate it exists so the error is
  // actionable ("you pointed at X, which isn't there") rather than ENOENT.
  if (config.zcodeExe && config.zcodeCjs && config.builtinProviderConfig) {
    const missing = []
    for (const key of ['zcodeExe', 'zcodeCjs', 'builtinProviderConfig']) {
      if (!isFile(config[key])) missing.push({ what: key, path: config[key] })
    }
    if (missing.length === 0) {
      out.ok = true
      out.zcodeExe = config.zcodeExe
      out.zcodeCjs = config.zcodeCjs
      out.builtinProviderConfig = config.builtinProviderConfig
      out.source = 'config'
      return out
    }
    out.missing = missing
    out.error = `插件配置里的路径不存在：${missing.map((m) => `${m.what}=${m.path}`).join('; ')}`
    out.hint = '删掉 cordis.patch.yml 里的这几行让插件自动探测，或改成实际路径。'
    return out
  }

  const found = findZCodeRoot({ env, root: config.zcodeRoot })
  out.tried = found.tried
  if (!found.root) {
    out.error = '未找到 ZCode 安装'
    out.hint =
      `请先安装 ZCode 官方客户端（${ZCODE_INSTALL_DOC}），` +
      '或设置 ZCODE_HOME 环境变量指向安装目录，或在 cordis.patch.yml 的 config 里显式指定 zcodeExe / zcodeCjs / builtinProviderConfig。'
    return out
  }

  out.root = found.root
  out.source = found.source

  const exe = isFile(config.zcodeExe) ? config.zcodeExe : findExecutable(found.root)
  const cjs = config.zcodeCjs && isFile(config.zcodeCjs) ? config.zcodeCjs : derive(found.root, REL.cjs)
  const builtin =
    config.builtinProviderConfig && isFile(config.builtinProviderConfig)
      ? config.builtinProviderConfig
      : derive(found.root, REL.builtin)

  for (const [what, path] of [
    ['zcodeExe', exe],
    ['zcodeCjs', cjs],
    ['builtinProviderConfig', builtin],
  ]) {
    if (isFile(path)) {
      out[what] = path
    } else {
      out.missing.push({ what, path })
    }
  }

  // zcode.cjs is the load-bearing one: without it the Electron shell has
  // nothing to run. The other two degrade gracefully (see index.js).
  if (out.missing.some((m) => m.what === 'zcodeCjs')) {
    out.ok = false
    out.error = `ZCode 安装目录里没有 resources/glm/zcode.cjs：${found.root}`
    out.hint = `ZCode 版本可能改过 CLI 入口布局，请在插件 config 里显式指定 zcodeCjs（安装根：${found.root}）。`
    return out
  }

  out.ok = true
  return out
}

// ── DSH user locations ────────────────────────────────────────────────────

/** ~/.dsh, honouring DSH_HOME when set. */
export function dshHomeDir(env = process.env) {
  if (env.DSH_HOME) return resolve(env.DSH_HOME)
  const home = env.USERPROFILE || env.HOME || homedir()
  return join(home, '.dsh')
}

/**
 * Where the generated provider-override json lives by default.
 * Deliberately under the DSH profile dir, NOT the repo checkout — the repo
 * may live on a read-only share or get cloned fresh on every update.
 */
export function defaultOverridePath(env = process.env) {
  if (env.DSH_ZCODE_OVERRIDE) return resolve(env.DSH_ZCODE_OVERRIDE)
  return join(dshHomeDir(env), 'zcode-provider-override.json')
}

/** ~/.dsh/.credentials.yaml — read-only; we never write it. */
export function credentialsPath(env = process.env) {
  return join(dshHomeDir(env), '.credentials.yaml')
}

/** ZCode's own user data dir (used for the verification channel, docs only). */
export function zcodeUserDir(env = process.env) {
  if (process.platform === 'win32') return join(env.USERPROFILE || homedir(), '.zcode')
  if (process.platform === 'darwin') return join(env.HOME || homedir(), '.zcode')
  return join(env.HOME || homedir(), '.zcode')
}

/** The sqlite audit trail that proves which provider actually served a call. */
export function zcodeUsageDb(env = process.env) {
  return join(zcodeUserDir(env), 'cli', 'db', 'db.sqlite')
}

/** Files this repo refuses to touch, named so the README can warn about them. */
export const NEVER_TOUCH = [
  {
    what: '桌面端 provider 注册表',
    pattern: '<ZCode 桌面端数据目录>/provider_config.json',
  },
  { what: 'ZCode 登录凭据', pattern: '~/.zcode/v2/credentials.json' },
]