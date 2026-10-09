// lib/schema.js — version-tolerant builder for the ZCode provider-override doc.
//
// WHY THIS EXISTS
// ---------------
// The override document is a private-ish shape that ZCode parses with a STRICT
// schema. Two hard-won facts, both established by A/B against the real CLI:
//
//   1. ZCode selects a provider by taking the first enabled entry of
//      `providerOrder`. Putting ours at [0] is what routes to the plan.
//   2. `modelConfigRules.manualProviderModelRules` must be PRESENT even when
//      empty — omitting it yields "Model creation failed".
//
// And one that changed the whole design (measured, see scripts/bisect-grow.mjs):
//
//   3. The personal override accepts ONLY the personal-provider keys. Adding a
//      single key that ZCode's own builtin catalog declares (modelRules,
//      modelApiRules, providerSiteRules, templateModelRules,
//      builtinProviderModelRules, providerConfigRules.templateRules …) makes
//      model creation FAIL. So "mirror whatever ZCode declares" is exactly
//      wrong: those catalog keys are the builtin file's business, not ours.
//
// THEREFORE the adaptive layer does not copy keys from ZCode's builtin config.
// It reads that file for one useful signal — whether the personal-provider shape
// we emit is still the one ZCode understands — and reports a clear warning when
// it isn't, instead of silently producing a config that fails at dispatch time
// with the famously unhelpful "Model creation failed".
//
// This is introspection, not reverse engineering: we read a file ZCode ships and
// shape our own config to the empirically-verified contract. We never write into
// ZCode's directories.
import { existsSync, readFileSync } from 'node:fs'

/**
 * The empirically-verified personal-provider shape (ZCode 3.14.5).
 * These are the ONLY keys the override document may contain.
 */
export const PERSONAL_MODEL_RULE_KEYS = Object.freeze(['providerModelRules', 'manualProviderModelRules'])
export const PERSONAL_PROVIDER_RULE_KEYS = Object.freeze(['providerRules'])

/** Keys ZCode's builtin catalog declares that must NOT be copied into ours. */
export const CATALOG_ONLY_HINTS = Object.freeze([
  'modelRules', 'modelApiRules', 'providerSiteRules',
  'templateModelRules', 'builtinProviderModelRules', 'templateRules',
])

export const FALLBACK_SHAPE = Object.freeze({
  schemaVersion: 1,
  personalModelRuleKeys: [...PERSONAL_MODEL_RULE_KEYS],
  personalProviderRuleKeys: [...PERSONAL_PROVIDER_RULE_KEYS],
  declaresPersonalKeys: true,
  source: 'fallback',
})

/**
 * Read ZCode's builtin provider config and report whether the personal-provider
 * shape we emit still lines up with what this ZCode version expects.
 *
 * We deliberately do NOT adopt the catalog's key set: the personal override is
 * a strict schema (fact #3 in the header). What we take from the catalog is a
 * compatibility signal for the human reading setup-check output.
 *
 * @param {string} builtinFile path to ZCode's `zcode-builtin.json`
 */
export function introspectSchema(builtinFile) {
  const fallback = (warning) => ({ ...FALLBACK_SHAPE, source: 'fallback', warning })
  if (!builtinFile || !existsSync(builtinFile)) {
    return fallback(`未找到 ZCode 内置 provider 配置：${builtinFile}`)
  }
  let doc
  try {
    doc = JSON.parse(readFileSync(builtinFile, 'utf8'))
  } catch (err) {
    return fallback(`ZCode 内置 provider 配置无法解析：${err && err.message}`)
  }
  const config = doc && typeof doc.config === 'object' && doc.config ? doc.config : {}
  const mcr = config.modelConfigRules && typeof config.modelConfigRules === 'object'
    ? config.modelConfigRules
    : {}
  const pcr = config.providerConfigRules && typeof config.providerConfigRules === 'object'
    ? config.providerConfigRules
    : {}
  if (!Object.keys(mcr).length && !Object.keys(pcr).length) {
    return fallback('ZCode 内置 provider 配置结构无法识别（缺少 providerConfigRules / modelConfigRules）')
  }

  const catalogModelKeys = Object.keys(mcr)
  const catalogProviderKeys = Object.keys(pcr)
  // If the catalog declares NONE of our personal keys, this ZCode may have
  // renamed the personal container. We cannot know the new name, so we keep the
  // verified shape and warn loudly instead of guessing.
  const declaresPersonalKeys =
    PERSONAL_MODEL_RULE_KEYS.some((k) => k in mcr) ||
    PERSONAL_PROVIDER_RULE_KEYS.some((k) => k in pcr)

  return {
    schemaVersion: Number.isFinite(doc.schemaVersion) ? doc.schemaVersion : 1,
    revision: Number.isFinite(doc.revision) ? doc.revision : undefined,
    catalogModelRuleKeys: catalogModelKeys,
    catalogProviderRuleKeys: catalogProviderKeys,
    declaresPersonalKeys,
    personalModelRuleKeys: [...PERSONAL_MODEL_RULE_KEYS],
    personalProviderRuleKeys: [...PERSONAL_PROVIDER_RULE_KEYS],
    source: 'builtin',
  }
}

/**
 * Keep for API compatibility with earlier revisions of this module.
 *
 * The personal-provider container is fixed (fact #3: unknown keys are fatal),
 * so "fill" is always the personal keys and "carry" is always empty. The
 * classification exists to make that decision explicit and testable.
 */
export function classifyRuleKeys(shape) {
  const personal = Array.isArray(shape && shape.personalModelRuleKeys)
    ? shape.personalModelRuleKeys
    : [...PERSONAL_MODEL_RULE_KEYS]
  return {
    fill: [...personal],
    all: [...personal],
    carry: [],
  }
}

/**
 * Build an override document that satisfies the introspected shape.
 *
 * Emits exactly the verified personal-provider keys — never the catalog keys,
 * which would make ZCode fail model creation.
 *
 * @returns {{doc:object, notes:string[], compatible:boolean}}
 */
export function buildAdaptiveOverride(o = {}) {
  const shape = o.shape && typeof o.shape === 'object' ? o.shape : FALLBACK_SHAPE
  const providerId = o.providerId || 'dsh-glm-coding-plan'
  const providerName = o.providerName || 'GLM Coding Plan (via ZCode)'
  const baseUrl = o.baseUrl || 'https://open.bigmodel.cn/api/anthropic'
  const modelIds = Array.isArray(o.modelIds) && o.modelIds.length
    ? o.modelIds
    : ['GLM-5.3-Flash', 'GLM-5.3']
  const contextWindow = Number(o.contextWindow) || 200000
  const apiKey = o.apiKey

  const notes = []
  let compatible = true

  if (shape.source === 'builtin') {
    if (shape.revision !== undefined) notes.push(`已对照 ZCode 内置配置（schema revision ${shape.revision}）`)
    if (shape.declaresPersonalKeys === false) {
      compatible = false
      notes.push(
        '⚠ 这个 ZCode 版本的目录里已看不到 personal provider 键，personal 覆盖结构可能已变更。' +
        '若派活报 Model creation failed，请对照 ZCode 内置配置调整 lib/schema.js 的 PERSONAL_* 常量。',
      )
    } else {
      notes.push(`schema 校验通过：personal 键（${PERSONAL_MODEL_RULE_KEYS.join(', ')}）仍被识别`)
    }
  } else {
    notes.push(`未读取到 ZCode 内置配置（${shape.warning || '未知原因'}），使用已验证的 personal 结构`)
  }

  const doc = {
    schemaVersion: Number.isFinite(shape.schemaVersion) ? shape.schemaVersion : 1,
    config: {
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
        // Required-present even when empty (fact #2). Keep it.
        manualProviderModelRules: [],
      },
    },
  }

  return { doc, notes, compatible }
}

/**
 * Does this override document satisfy the introspected shape? Used by the
 * self-check to warn before a dispatch that would fail at model-creation time.
 */
export function validateAgainstShape(doc, shape) {
  const problems = []
  const mcr = doc && doc.config && doc.config.modelConfigRules
  if (!mcr || typeof mcr !== 'object') {
    problems.push('override 缺少 modelConfigRules')
    return problems
  }
  // Our personal keys must all be present, with the companion even if empty.
  for (const key of PERSONAL_MODEL_RULE_KEYS) {
    if (!(key in mcr)) problems.push(`override 缺少 modelConfigRules.${key}`)
    else if (!Array.isArray(mcr[key])) problems.push(`override 的 modelConfigRules.${key} 不是数组`)
  }
  const pcr = doc && doc.config && doc.config.providerConfigRules
  if (!pcr || typeof pcr !== 'object') {
    problems.push('override 缺少 providerConfigRules')
  } else {
    for (const key of PERSONAL_PROVIDER_RULE_KEYS) {
      if (!(key in pcr)) problems.push(`override 缺少 providerConfigRules.${key}`)
    }
    // Fact #3: unknown keys are fatal to ZCode. Flag them loudly so a future
    // ZCode rename is diagnosed here rather than as "Model creation failed".
    const extraPcr = Object.keys(pcr).filter((k) => !PERSONAL_PROVIDER_RULE_KEYS.includes(k))
    for (const k of extraPcr) problems.push(`override 含 ZCode 不接受的 providerConfigRules.${k}`)
  }
  const extraMcr = Object.keys(mcr).filter((k) => !PERSONAL_MODEL_RULE_KEYS.includes(k))
  for (const k of extraMcr) problems.push(`override 含 ZCode 不接受的 modelConfigRules.${k}`)

  const order = doc && doc.config && doc.config.providerOrder
  if (!Array.isArray(order) || order.length === 0) problems.push('override 缺少 providerOrder')
  return problems
}