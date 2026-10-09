// lib/override.js — build the ZCode provider-override config, and read the
// coding-plan API key out of DSH's credentials file.
//
// The override is the whole trick: ZCode selects a provider by taking the FIRST
// enabled entry of `providerOrder`, so listing our provider first routes the
// CLI at the coding-plan endpoint. The generated file is written to the user's
// DSH profile dir (default ~/.dsh/zcode-provider-override.json) and pointed at
// via ZCODE_PERSONAL_PROVIDER_CONFIG_FILE at spawn time. We never touch the
// ZCode desktop registry or ~/.zcode/v2/credentials.json.
import { existsSync, readFileSync } from 'node:fs'
import { credentialsPath } from './paths.js'
import { introspectSchema, buildAdaptiveOverride, FALLBACK_SHAPE } from './schema.js'

export const CODES_KEY_REF = 'BIGMODEL_CODING_PLAN_API_KEY'

/**
 * Minimal reader for the flat `refs:` map inside ~/.dsh/.credentials.yaml.
 * That file is a small YAML doc; we only need top-level two-space-indented
 * scalars under `refs:`, so a targeted regex beats pulling in a YAML dep.
 * Returns undefined when the ref is missing or empty.
 */
export function readCredentialRef(file, key) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const lines = text.split(/\r?\n/)
  let inRefs = false
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (inRefs && /^\S/.test(line)) break // next top-level key
    if (!inRefs) continue
    const m = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/)
    if (m && m[1] === key) {
      const val = m[2].trim().replace(/^["']|["']$/g, '')
      return val.length ? val : undefined
    }
  }
  return undefined
}

/**
 * Read the coding-plan key from the DSH credentials file.
 * @param {object} [env] process.env-shaped; DSH_HOME / USERPROFILE honoured
 * @returns {string|undefined} the key, or undefined when the ref is absent
 */
export function loadCodingPlanKey(env = process.env) {
  return readCredentialRef(env.DSH_CREDENTIALS_FILE || credentialsPath(env), CODES_KEY_REF)
}

/**
 * Compose the provider-override document.
 *
 * Two modes:
 *   - adaptive (default when `builtinProviderConfig` is readable): ask
 *     lib/schema.js whether the personal-provider shape we emit still matches
 *     what this ZCode build understands, and surface a loud warning when it
 *     does not. Deliberately does NOT copy ZCode's catalog keys — measured on
 *     3.14.5: adding any of them to a personal override makes model creation
 *     fail. See lib/schema.js header.
 *   - static: the pinned shape verified A/B against ZCode 3.14.5, used when the
 *     builtin file can't be read (fresh install, odd packaging).
 *
 * Both modes emit exactly the personal keys and nothing else:
 * `providerOrder[0]` = our provider, plus `providerModelRules` and
 * `manualProviderModelRules`.
 *
 * @param {object} o { apiKey, providerId, providerName, baseUrl, modelIds,
 *                     contextWindow, builtinProviderConfig }
 * @returns {{doc:object, notes:string[]}}
 */
export function buildOverrideConfig(o = {}) {
  const opts = typeof o === 'object' && o ? o : {}

  // Schema-adaptive path: learn the shape from ZCode itself.
  if (opts.builtinProviderConfig) {
    const shape = introspectSchema(opts.builtinProviderConfig)
    if (shape.source === 'builtin') {
      return buildAdaptiveOverride({ ...opts, shape })
    }
    // Builtin unreadable → fall through to the static shape, but say so.
    const staticResult = buildStaticOverride(opts)
    staticResult.notes.unshift(`schema 自适应不可用，已回退静态形状：${shape.warning || '未知原因'}`)
    return staticResult
  }
  return buildStaticOverride(opts)
}

/**
 * The pinned shape, verified A/B against ZCode 3.14.5:
 *   - `providerOrder[0]` is what ZCode routes on (first enabled wins).
 *   - `modelConfigRules.manualProviderModelRules` must EXIST even when empty;
 *     omitting it produces "Model creation failed".
 */
function buildStaticOverride(o = {}) {
  const providerId = o.providerId || 'dsh-glm-coding-plan'
  const providerName = o.providerName || 'GLM Coding Plan (via ZCode)'
  const baseUrl = o.baseUrl || 'https://open.bigmodel.cn/api/anthropic'
  const modelIds = Array.isArray(o.modelIds) && o.modelIds.length
    ? o.modelIds
    : ['GLM-5.3-Flash', 'GLM-5.3']
  const contextWindow = Number(o.contextWindow) || 200000
  const apiKey = o.apiKey

  const doc = {
    schemaVersion: 1,
    config: {
      // ZCode picks the first ENABLED provider in this list — index 0 wins.
      providerOrder: [providerId],
      providerConfigRules: {
        providerRules: [
          {
            providerId,
            providerName,
            config: {
              group: 'standard-personal',
              access: { type: 'api-key', apiKey },
              api: { type: 'anthropic-messages', baseUrl },
              personalModelIds: modelIds,
              modelOrder: modelIds,
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: modelIds.map((modelId) => ({
          modelId,
          providerId,
          config: { properties: { contextWindow } },
        })),
        // ZCode 3.14.5 reads this key while resolving models and throws
        // "Model creation failed" when the whole modelConfigRules object is
        // missing it. A/B verified against the real CLI: with `[]` the call
        // succeeds, without it model creation fails. Keep it, even empty.
        manualProviderModelRules: [],
      },
    },
  }
  return {
    doc,
    notes: ['使用静态 provider 形状（未经 ZCode 内置配置自适应）'],
  }
}

/** True when the file already contains our provider at providerOrder[0]. */
export function overrideLooksValid(file, providerId = 'dsh-glm-coding-plan') {
  if (!existsSync(file)) return false
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    const order = doc?.config?.providerOrder
    return Array.isArray(order) && order[0] === providerId
  } catch {
    return false
  }
}