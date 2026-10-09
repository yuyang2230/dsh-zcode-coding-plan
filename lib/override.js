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
 * @param {object} o { apiKey, providerId, providerName, baseUrl, modelIds, contextWindow }
 */
export function buildOverrideConfig(o = {}) {
  const providerId = o.providerId || 'dsh-glm-coding-plan'
  const providerName = o.providerName || 'GLM Coding Plan (via ZCode)'
  const baseUrl = o.baseUrl || 'https://open.bigmodel.cn/api/anthropic'
  const modelIds = Array.isArray(o.modelIds) && o.modelIds.length
    ? o.modelIds
    : ['GLM-5.3-Flash', 'GLM-5.3']
  const contextWindow = Number(o.contextWindow) || 200000
  const apiKey = o.apiKey

  return {
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