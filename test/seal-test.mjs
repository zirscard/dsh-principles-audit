/**
 * dsh-principles-audit · 封版/颠覆/账本 测试套件（v0.4 P0）
 *
 * 运行：node test/seal-test.mjs
 * 覆盖：封版判据拒绝/通过、静默篡改、伪造哈希、颠覆记录完整性、
 *       orphan、复核到期、判据失守、账本断链、版本谱系不误报冲突。
 * 退出码：0 全过；1 有失败。
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { audit } from '../core/audit.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TMP = join(ROOT, 'test', 'tmp')

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ---------------- 夹具 ---------------- */

const SEALABLE = {
  principle_id: 'PR-A',
  name: '高PS估值须警惕一二级倒挂',
  causal_statement: '当一级市场PS远超可比且持续亏损时，IPO退出面临价格倒挂风险。',
  applicable_conditions: '高估值、依赖IPO退出的未盈利项目。',
  counter_examples: '业绩兑现消化估值的情形（订单锁定+预收入）。',
  industry: '全局',
  dimension_id: 'D01',
  source: '公司教训',
  evidence: ['投前PS 25倍 vs 可比6倍'],
  confidence: 0.9,
  verified_count: 5,
  violated_count: 0,
  cross_scenario_count: 3,
  status: '活跃',
  updated_at: '2026-10-01',
  version: 'v1.0',
  falsification: {
    condition: '业绩兑现消化估值',
    status: 'real_case',
    cases: [{ type: 'real_case', company: '百济神州', year: '2025', condition_met: '高PS', actual_outcome: '盈利消化', source: '公告', evidence_grade: 'B', why_principle_failed: '管线兑现' }],
  },
  outcome_validation: { label_count: 5, window: '2024-2025', method: 'loo', pre_registered_at: '2026-01-01', result: 'supported', result_value: 0.8 },
}

const UNVERIFIED = {
  ...SEALABLE,
  principle_id: 'PR-B',
  name: '持续亏损依赖融资输血须评估流动性',
  causal_statement: '持续亏损且经营现金流为负时，须评估12-24个月流动性安全边际。',
  verified_count: 0,
  cross_scenario_count: 1,
  falsification: { condition: '现金流转正', status: 'missing', cases: [] },
  outcome_validation: { label_count: 0, window: null, method: 'not_available', pre_registered_at: null, result: 'not_available', result_value: null },
}

function writeTemplate() {
  rmSync(TMP, { recursive: true, force: true })
  const template = join(TMP, '_template')
  mkdirSync(join(template, 'data', 'projects', '甲'), { recursive: true })
  mkdirSync(join(template, 'data', 'projects', '乙'), { recursive: true })
  writeFileSync(join(template, 'data', 'projects', '甲', 'principles.json'),
    `${JSON.stringify({ principles: [SEALABLE], generation_notes: '夹具：甲项目' }, null, 2)}\n`)
  writeFileSync(join(template, 'data', 'projects', '乙', 'principles.json'),
    `${JSON.stringify({ principles: [UNVERIFIED], generation_notes: '夹具：乙项目' }, null, 2)}\n`)
  return template
}

function freshLib(name, template) {
  const lib = join(TMP, name)
  cpSync(template, lib, { recursive: true })
  return lib
}

function runCli(args) {
  return spawnSync(process.execPath, [join(ROOT, 'seal-cli.js'), ...args], { encoding: 'utf8' })
}

function runAudit(lib) {
  return audit({ path: lib, outputDir: join(TMP, 'reports') })
}

function codes(result, severity) {
  return result.findings.filter((f) => severity === undefined || f.severity === severity).map((f) => f.code)
}

function editPrinciple(lib, project, pid, mutate) {
  const file = join(lib, 'data', 'projects', project, 'principles.json')
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const entry = data.principles.find((p) => p.principle_id === pid)
  if (entry === undefined) throw new Error(`找不到 ${pid}`)
  mutate(entry)
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

/* ---------------- 用例 ---------------- */

const template = writeTemplate()

console.log('T1 判据未满足 → seal 拒绝')
{
  const lib = freshLib('t1', template)
  const r = runCli(['--library', lib, 'seal', '--id', 'PR-B', '--actor', 'tester'])
  check('退出码 1', r.status === 1, `status=${r.status} stderr=${r.stderr.trim()}`)
  check('拒绝原因含判据', r.stderr.includes('判据未满足'), r.stderr.trim())
}

console.log('T2 判据满足 → seal 成功 → 审计无封版问题')
{
  const lib = freshLib('t2', template)
  const r = runCli(['--library', lib, 'seal', '--id', 'PR-A', '--actor', 'tester', '--evidence', 'VR-1,VR-2'])
  check('退出码 0', r.status === 0, r.stderr.trim())
  check('账本已生成', existsSync(join(lib, 'state', 'principle-ledger.jsonl')))
  const result = runAudit(lib)
  const sealCodes = ['seal-integrity', 'silent-seal-edit', 'overturn-incomplete', 'seal-orphan', 'ledger-chain-broken']
  const hit = result.findings.filter((f) => sealCodes.includes(f.code))
  check('无封版类 critical', hit.length === 0, JSON.stringify(hit.map((f) => `${f.code}:${f.title}`)))
  check('gate 不因封版 fail', result.gate.status !== 'fail' || !hit.some((f) => f.severity === 'critical'), `gate=${result.gate.status}`)
  check('summary.sealed=1', result.summary.sealed === 1, JSON.stringify(result.summary))
  const v = runCli(['--library', lib, 'verify'])
  check('verify 退出码 0', v.status === 0, v.stdout + v.stderr)
}

console.log('T3 封版后改规范字段 → silent-seal-edit critical → gate fail')
{
  const lib = freshLib('t3', template)
  runCli(['--library', lib, 'seal', '--id', 'PR-A', '--actor', 'tester'])
  editPrinciple(lib, '甲', 'PR-A', (p) => { p.causal_statement = '被偷偷改写的因果句。' })
  const result = runAudit(lib)
  check('silent-seal-edit critical', codes(result, 'critical').includes('silent-seal-edit'), JSON.stringify(codes(result, 'critical')))
  check('gate=fail', result.gate.status === 'fail', `gate=${result.gate.status}`)
}

console.log('T4 伪造 content_hash → seal-integrity critical')
{
  const lib = freshLib('t4', template)
  runCli(['--library', lib, 'seal', '--id', 'PR-A', '--actor', 'tester'])
  editPrinciple(lib, '甲', 'PR-A', (p) => { p.seal.content_hash = `sha256:${'f'.repeat(64)}` })
  const result = runAudit(lib)
  check('seal-integrity critical', codes(result, 'critical').includes('seal-integrity'), JSON.stringify(codes(result, 'critical')))
  check('gate=fail', result.gate.status === 'fail')
}

console.log('T5 颠覆缺要素 → buildSupersession 拒绝')
{
  const lib = freshLib('t5', template)
  runCli(['--library', lib, 'seal', '--id', 'PR-A', '--actor', 'tester'])
  const r = runCli(['--library', lib, 'overturn', '--id', 'PR-A', '--mode', 'retire', '--trigger', 'counter_example', '--diagnosis', '', '--evidence', 'x', '--actor', 't'])
  check('退出码 1', r.status === 1, r.stdout + r.stderr)
  check('报 I9', (r.stderr + r.stdout).includes('I9') || (r.stderr + r.stdout).includes('diagnosis'), r.stderr.trim())
}

console.log('T6 合法 retire → 审计干净；T7 orphan → critical')
{
  const lib = freshLib('t6', template)
  runCli(['--library', lib, 'seal', '--id', 'PR-A', '--actor', 'tester'])
  const r = runCli(['--library', lib, 'overturn', '--id', 'PR-A', '--mode', 'retire', '--trigger', 'counter_example', '--diagnosis', '边界缺少订单锁定前置条件', '--evidence', 'CE-1', '--actor', 't'])
  check('retire 退出码 0', r.status === 0, r.stdout + r.stderr)
  const result = runAudit(lib)
  const criticals = codes(result, 'critical')
  check('retire 后无 critical', criticals.length === 0, JSON.stringify(criticals))
  check('summary.overturned 计入 retire 路径不误标', result.summary.sealed === 1)

  const lib2 = freshLib('t7', template)
  runCli(['--library', lib2, 'seal', '--id', 'PR-A', '--actor', 'tester'])
  editPrinciple(lib2, '乙', 'PR-B', (p) => {
    p.supersession = { supersedes: 'SEAL-不存在-v9.9', mode: 'revise', trigger: 'violation', evidence_refs: ['x'], diagnosis: 'y', decided_by: { id: 't' }, decided_at: '2026-10-19' }
  })
  const result2 = runAudit(lib2)
  check('seal-orphan critical', codes(result2, 'critical').includes('seal-orphan'), JSON.stringify(codes(result2, 'critical')))
}

console.log('T8 复核到期 → warning 不阻断；判据失守 → warning')
{
  const lib = freshLib('t8', template)
  runCli(['--library', lib, 'seal', '--id', 'PR-A', '--actor', 'tester'])
  editPrinciple(lib, '甲', 'PR-A', (p) => {
    p.seal.next_review_at = '2025-01-01'
    p.verified_count = 2
  })
  const result = runAudit(lib)
  const warnings = codes(result, 'warning')
  check('seal-review-due warning', warnings.includes('seal-review-due'), JSON.stringify(warnings))
  check('seal-eligibility warning', warnings.includes('seal-eligibility'))
  check('非计数字段变更不触发 silent-seal-edit', !codes(result, 'critical').includes('silent-seal-edit'))
  check('gate 不因 warning fail', result.gate.status !== 'fail', `gate=${result.gate.status}`)
}

console.log('T9 账本篡改 → ledger-chain-broken critical + verify 退出码 1')
{
  const lib = freshLib('t9', template)
  runCli(['--library', lib, 'seal', '--id', 'PR-A', '--actor', 'tester'])
  runCli(['--library', lib, 'seal', '--id', 'PR-B', '--actor', 'tester', '--force'])
  const ledger = join(lib, 'state', 'principle-ledger.jsonl')
  const lines = readFileSync(ledger, 'utf8').split('\n').filter((l) => l.trim() !== '')
  const tampered = JSON.parse(lines[0])
  tampered.content_hash = `sha256:${'a'.repeat(64)}`
  lines[0] = JSON.stringify(tampered)
  writeFileSync(ledger, `${lines.join('\n')}\n`)
  const v = runCli(['--library', lib, 'verify'])
  check('verify 退出码 1', v.status === 1, v.stdout + v.stderr)
  const result = runAudit(lib)
  check('ledger-chain-broken critical', codes(result, 'critical').includes('ledger-chain-broken'), JSON.stringify(codes(result, 'critical')))
  check('gate=fail', result.gate.status === 'fail')
}

console.log('T10 revise 继任 → 版本谱系不误报 id-collision')
{
  const lib = freshLib('t10', template)
  runCli(['--library', lib, 'seal', '--id', 'PR-A', '--actor', 'tester'])
  const r = runCli(['--library', lib, 'overturn', '--id', 'PR-A', '--mode', 'revise', '--trigger', 'counter_example', '--diagnosis', '补订单锁定前置条件', '--evidence', 'CE-1', '--actor', 't', '--diff', 'causal_statement 增加前置条件'])
  check('revise 退出码 0', r.status === 0, r.stdout + r.stderr)
  const result = runAudit(lib)
  const criticals = codes(result, 'critical')
  check('无 id-collision（pid@version 分组）', !criticals.includes('id-collision'), JSON.stringify(criticals))
  check('无 overturn-incomplete', !criticals.includes('overturn-incomplete'))
  check('summary.overturned=1', result.summary.overturned === 1, JSON.stringify(result.summary))
  check('summary.sealed=1（旧封版保留）', result.summary.sealed === 1)
  const file = join(lib, 'data', 'projects', '甲', 'principles.json')
  const data = JSON.parse(readFileSync(file, 'utf8'))
  check('继任条目 v1.1 + supersession', data.principles.some((p) => p.version === 'v1.1' && p.supersession?.supersedes?.startsWith('SEAL-PR-A')))
  check('旧条目 overturned 终态', data.principles.some((p) => p.version === 'v1.0' && p.lifecycle_state === 'overturned'))
}

console.log('')
console.log(`结果：${passed} 通过，${failures.length} 失败`)
if (failures.length > 0) {
  console.log(`失败用例：${failures.join('；')}`)
  process.exit(1)
}
process.exit(0)
