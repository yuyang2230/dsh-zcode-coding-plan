#!/usr/bin/env node
// test/schema.test.mjs — the schema-verification layer.
//
// Premise: the override document's shape is ZCode-private and parsed strictly.
// v0.2.0 shipped a hardcoded shape; v0.3.0 adds lib/schema.js, which reads
// ZCode's own builtin provider config and REPORTS whether our personal shape
// still fits, instead of silently emitting a config that dies at dispatch with
// the famously unhelpful "Model creation failed".
//
// The three measured facts these tests lock in:
//   1. providerOrder[0] is what routes to our provider.
//   2. modelConfigRules.manualProviderModelRules must be present (empty ok).
//   3. Catalog keys (modelRules, templateModelRules, providerConfigRules
//      .templateRules, …) are FATAL in a personal override — verified by
//      bisect A/B against the real CLI (see scripts/e2e-adaptive.mjs).
//
// No ZCode, no key, no spawn. Fixtures live in tmpdir.
//
//   node test/schema.test.mjs
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  introspectSchema,
  classifyRuleKeys,
  buildAdaptiveOverride,
  validateAgainstShape,
  PERSONAL_MODEL_RULE_KEYS,
  PERSONAL_PROVIDER_RULE_KEYS,
  CATALOG_ONLY_HINTS,
  FALLBACK_SHAPE,
} from '../lib/schema.js'
import { buildOverrideConfig } from '../lib/override.js'

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const tmp = mkdtempSync(join(tmpdir(), 'dsh-zcode-schema-'))
const fixture = (name, obj) => {
  const f = join(tmp, name)
  writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), 'utf8')
  return f
}

console.log('dsh-zcode-coding-plan · schema verification tests\n')

// The real 3.14.5 builtin shape, verbatim in structure. Note it DOES declare
// providerRules (on the provider side) even though its model side declares only
// catalog keys — verified against the installed ZCode, revision 30.
const REAL_CATALOG = {
  schemaVersion: 1,
  revision: 30,
  config: {
    providerConfigRules: { templateRules: [{ templateId: 'zai-api', config: {} }], providerRules: [] },
    modelConfigRules: {
      modelRules: [],
      modelApiRules: [],
      providerSiteRules: [],
      templateModelRules: [],
      builtinProviderModelRules: [],
    },
  },
}

// ── 1. introspection against the real catalog ──
console.log('[1] 内省 ZCode 真实目录（3.14.5 观测结构）')
{
  const shape = introspectSchema(fixture('real.json', REAL_CATALOG))
  check('source is builtin', shape.source === 'builtin')
  check('reads schemaVersion + revision', shape.schemaVersion === 1 && shape.revision === 30)
  check('records catalog model keys', shape.catalogModelRuleKeys.length === 5,
    JSON.stringify(shape.catalogModelRuleKeys))
  check('records catalog provider keys', shape.catalogProviderRuleKeys.includes('templateRules'))
  // Verified against the installed ZCode (revision 30): the catalog declares
  // providerRules, so our personal contract still overlaps it.
  check('detects the personal providerRules the catalog still declares',
    shape.declaresPersonalKeys === true)
}

// ── 2. the generated doc is the verified personal shape, and nothing more ──
console.log('\n[2] 生成的产物只含 personal 键（事实 #3：多余键致命）')
{
  const shape = introspectSchema(fixture('real2.json', REAL_CATALOG))
  const { doc, notes, compatible } = buildAdaptiveOverride({ apiKey: 'k', shape })
  const mcr = doc.config.modelConfigRules
  const pcr = doc.config.providerConfigRules

  check('providerOrder[0] is our provider (fact #1)',
    doc.config.providerOrder[0] === 'dsh-glm-coding-plan')
  check('providerConfigRules has exactly providerRules',
    JSON.stringify(Object.keys(pcr)) === JSON.stringify(['providerRules']))
  check('modelConfigRules has exactly the personal keys',
    JSON.stringify(Object.keys(mcr).sort()) ===
      JSON.stringify([...PERSONAL_MODEL_RULE_KEYS].sort()), Object.keys(mcr).join(','))
  check('manualProviderModelRules present even when empty (fact #2)',
    Array.isArray(mcr.manualProviderModelRules) && mcr.manualProviderModelRules.length === 0)
  check('our models are registered', mcr.providerModelRules.length === 2)

  // The regression that matters: none of ZCode's catalog keys leak into ours.
  for (const key of CATALOG_ONLY_HINTS) {
    check(`no catalog key "${key}" leaked`, !(key in mcr) && !(key in pcr))
  }
  // Verified against the installed ZCode (revision 30): REAL_CATALOG still
  // declares providerRules, so the personal contract still overlaps it and the
  // verdict is compatible — it's "mirror the catalog" that's dead, not us.
  check('flags the catalog shape as compatible with our personal contract',
    compatible === true)
  check('says so in notes', notes.some((n) => n.includes('schema 校验通过')),
    JSON.stringify(notes))
  // The incompatible branch still has to speak up: a catalog that declares
  // none of our keys must flip `compatible` and name the failure mode.
  const orphanShape = introspectSchema(fixture('no-personal.json', {
    schemaVersion: 1,
    config: {
      providerConfigRules: { templateRules: [{ templateId: 'zai-api', config: {} }] },
      modelConfigRules: { modelRules: [] },
    },
  }))
  const orphan = buildAdaptiveOverride({ apiKey: 'k', shape: orphanShape })
  check('a catalog without any personal key is flagged incompatible',
    orphan.compatible === false)
  check('and the warning tells the user what to do about it',
    orphan.notes.some((n) => n.includes('Model creation failed') && n.includes('PERSONAL_')),
    JSON.stringify(orphan.notes))
  check('validates clean against its own shape',
    validateAgainstShape(doc, shape).length === 0,
    JSON.stringify(validateAgainstShape(doc, shape)))
}

// ── 3. a ZCode that DOES declare personal keys reads as compatible ──
console.log('\n[3] 目录里出现 personal 键 → 判定兼容')
{
  const shape = introspectSchema(fixture('with-personal.json', {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  }))
  check('detects personal keys', shape.declaresPersonalKeys === true)
  const { doc, compatible, notes } = buildAdaptiveOverride({ apiKey: 'k', shape })
  check('marks compatible', compatible === true)
  check('notes say the schema checked out', notes.some((n) => n.includes('schema 校验通过')))
  check('still emits only personal keys',
    JSON.stringify(Object.keys(doc.config.modelConfigRules).sort()) ===
      JSON.stringify([...PERSONAL_MODEL_RULE_KEYS].sort()))
}

// ── 4. unknown-key detection: the guard against a future rename ──
console.log('\n[4] 校验能抓出 ZCode 不接受的键')
{
  const doc = {
    config: {
      providerOrder: ['dsh-glm-coding-plan'],
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [], modelRules: [] },
    },
  }
  const problems = validateAgainstShape(doc, { source: 'fallback' })
  check('flags a catalog key smuggled into modelConfigRules',
    problems.some((p) => p.includes('modelRules') && p.includes('不接受')), JSON.stringify(problems))

  const doc2 = JSON.parse(JSON.stringify(doc))
  delete doc2.config.modelConfigRules.modelRules
  doc2.config.providerConfigRules.templateRules = []
  check('flags a catalog key smuggled into providerConfigRules',
    validateAgainstShape(doc2, { source: 'fallback' })
      .some((p) => p.includes('templateRules') && p.includes('不接受')))

  const doc3 = { config: { providerOrder: ['x'], providerConfigRules: {}, modelConfigRules: {} } }
  check('flags missing containers and keys', validateAgainstShape(doc3, { source: 'fallback' }).length >= 3)
  check('flags a non-array value',
    validateAgainstShape(
      { config: { providerOrder: ['x'], providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: 'no', manualProviderModelRules: [] } } },
      { source: 'fallback' },
    ).some((p) => p.includes('不是数组')))
}

// ── 5. degradation when the catalog can't be read ──
console.log('\n[5] 读不到目录时安全降级')
{
  check('missing file falls back', introspectSchema(join(tmp, 'nope.json')).source === 'fallback')
  const broken = fixture('broken.json', '{ not json')
  const s1 = introspectSchema(broken)
  check('unparseable file falls back with a warning',
    s1.source === 'fallback' && typeof s1.warning === 'string')
  const alien = fixture('alien.json', { schemaVersion: 1, config: { nope: true } })
  check('unrecognised structure falls back', introspectSchema(alien).source === 'fallback')

  const { doc } = buildOverrideConfig({ apiKey: 'k' })
  check('fallback still emits providerModelRules', doc.config.modelConfigRules.providerModelRules.length === 2)
  check('fallback still emits manualProviderModelRules',
    Array.isArray(doc.config.modelConfigRules.manualProviderModelRules))
  check('fallback keeps providerOrder[0]', doc.config.providerOrder[0] === 'dsh-glm-coding-plan')
  check('fallback emits no catalog keys',
    CATALOG_ONLY_HINTS.every((k) => !(k in doc.config.modelConfigRules)))
  // 传了但读不到 → 走 buildOverrideConfig 的回退分支，notes 里说明原因。
  // （"未读取到…"是 buildAdaptiveOverride 内部的文案，这条路径到不了那个分支。）
  check('unreadable builtin is reported as a fallback in notes',
    buildOverrideConfig({ apiKey: 'k', builtinProviderConfig: broken })
      .notes.some((n) => n.includes('回退静态形状')))
  // 完全没传 builtin → 纯静态 notes，恰好一行。
  const pureStatic = buildOverrideConfig({ apiKey: 'k' })
  check('no builtin at all yields the pure static note',
    pureStatic.notes.length === 1 &&
    pureStatic.notes[0].includes('使用静态 provider 形状（未经 ZCode 内置配置自适应）'))
}

// ── 6. classifyRuleKeys stays honest ──
console.log('\n[6] 分类函数保持一致')
{
  const c = classifyRuleKeys({ personalModelRuleKeys: ['providerModelRules', 'manualProviderModelRules'] })
  check('fill is the personal keys', c.fill.length === 2)
  check('carry is always empty (strict schema)', c.carry.length === 0)
  check('tolerates an empty shape', Array.isArray(classifyRuleKeys({}).all))
  check('ignores a catalog key list if one is passed in',
    classifyRuleKeys({ personalModelRuleKeys: ['modelRules'] }).fill.includes('modelRules'))
}

// ── 7. invariants that must hold for any input ──
console.log('\n[7] 不变量')
{
  const inputs = [
    { source: 'fallback' },
    introspectSchema(fixture('i1.json', REAL_CATALOG)),
    introspectSchema(fixture('i2.json', { schemaVersion: 9, config: { providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [] } } })),
    { source: 'builtin', declaresPersonalKeys: true, catalogModelRuleKeys: [], schemaVersion: 1 },
  ]
  for (const [i, shape] of inputs.entries()) {
    const { doc } = buildAdaptiveOverride({ apiKey: 'k', shape, modelIds: ['A', 'B'] })
    const tag = `#${i} source=${shape.source}`
    check(`${tag}: providerOrder[0] is ours`, doc.config.providerOrder[0] === 'dsh-glm-coding-plan')
    check(`${tag}: exactly one provider rule`, doc.config.providerConfigRules.providerRules.length === 1)
    check(`${tag}: our two models registered`, doc.config.modelConfigRules.providerModelRules.length === 2)
    check(`${tag}: no catalog keys present`,
      CATALOG_ONLY_HINTS.every((k) => !(k in doc.config.modelConfigRules) && !(k in doc.config.providerConfigRules)))
    check(`${tag}: validates clean`, validateAgainstShape(doc, shape).length === 0)
  }
  check('FALLBACK_SHAPE is frozen', Object.isFrozen(FALLBACK_SHAPE))
  check('key constants are frozen',
    Object.isFrozen(PERSONAL_MODEL_RULE_KEYS) && Object.isFrozen(CATALOG_ONLY_HINTS))
}

// ── 8. 回归锁：catalog 键致命（实测事实） ──
console.log('\n[8] 回归锁：任何生成路径的 doc 都不含 catalog 键')
{
  // 实测来源：2026-10-09 在真实 CLI 上二分 A/B（Windows + ZCode 3.14.5，
  // schema revision 30；脚本见 scripts/e2e-adaptive.mjs，机制说明见
  // docs/how-it-works.md「provider schema 自适应与严格性」）。
  // personal 覆盖是严格 schema：在 modelConfigRules / providerConfigRules 里
  // 加入任何一个 catalog 键——modelRules、modelApiRules、providerSiteRules、
  // templateModelRules、builtinProviderModelRules、providerConfigRules
  // .templateRules——都会导致 Model creation failed。
  // “镜像填充 ZCode 内置目录键”因此被实测证伪；这条锁保证静态与自适应两条
  // 生成路径产出的文档全树一个 catalog 键都没有。
  const collectKeys = (node, acc = new Set()) => {
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) { acc.add(k); collectKeys(v, acc) }
    }
    return acc
  }
  const builtin = fixture('regression-builtin.json', REAL_CATALOG)
  const generated = [
    ['静态路径', buildOverrideConfig({ apiKey: 'k' }).doc],
    ['自适应路径', buildOverrideConfig({ apiKey: 'k', builtinProviderConfig: builtin }).doc],
  ]
  for (const [tag, doc] of generated) {
    const keys = collectKeys(doc)
    for (const hint of CATALOG_ONLY_HINTS) {
      check(`${tag} 全树不含 catalog 键 "${hint}"`, !keys.has(hint))
    }
  }
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${pass} passed, ${fail} failed`)
if (fail) {
  console.log('failed:', failures.join(' | '))
  process.exit(1)
}
