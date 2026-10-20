/**
 * dsh-principles-audit · P1 工具测试（vr-cli / cross-cli）
 *
 * 运行：node test/p1-tools-test.mjs
 * 覆盖：VR 校验/导入/I2 重算/重复 ID 拒绝；cross 校验/dry-run/apply/I3 重算。
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TMP = join(ROOT, 'test', 'tmp-p1')

let passed = 0
const failures = []
function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const BASE = {
  name: '测试原则', causal_statement: '当 X 成立时，Y 风险上升。', applicable_conditions: '条件 X。',
  counter_examples: '反例 Y0。', industry: '全局', dimension_id: 'D07', source: '测试',
  evidence: ['证据 1'], confidence: 0.9, verified_count: 0, violated_count: 0, cross_scenario_count: 1,
  status: '活跃', updated_at: '2026-10-01', version: 'v1.1',
  falsification: { condition: 'Y0', status: 'real_case', cases: [{ type: 'real_case' }] },
  outcome_validation: { label_count: 0, window: null, method: 'not_available', pre_registered_at: null, result: 'not_available', result_value: null },
}

function writeTemplate() {
  rmSync(TMP, { recursive: true, force: true })
  const template = join(TMP, '_template')
  for (const [project, id, name] of [['甲', '甲-PR-001', '甲原则'], ['乙', '乙-PR-001', '乙原则'], ['丙', '丙-PR-001', '丙原则']]) {
    mkdirSync(join(template, 'data', 'projects', project), { recursive: true })
    writeFileSync(join(template, 'data', 'projects', project, 'principles.json'),
      `${JSON.stringify({ principles: [{ ...BASE, principle_id: id, name }], generation_notes: `夹具：${project}` }, null, 2)}\n`)
  }
  return template
}

function freshLib(name, template) {
  const lib = join(TMP, name)
  cpSync(template, lib, { recursive: true })
  return lib
}

function run(script, args) {
  return spawnSync(process.execPath, [join(ROOT, script), ...args], { encoding: 'utf8' })
}

function readPrinciple(lib, project, pid) {
  const data = JSON.parse(readFileSync(join(lib, 'data', 'projects', project, 'principles.json'), 'utf8'))
  return data.principles.find((p) => p.principle_id === pid)
}

const template = writeTemplate()

console.log('VR-1 validate 只校验不写')
{
  const lib = freshLib('vr1', template)
  const csv = join(TMP, 'vr-valid.csv')
  writeFileSync(csv, 'record_id,principle_id,occurred_at,result,project_ref,evidence,recorded_by\nVR-1,甲-PR-001,2026-10-01,hit,甲,证据 A,manual\nVR-2,甲-PR-001,2026-10-02,hit,甲,证据 B,manual\n')
  const r = run('vr-cli.js', ['--library', lib, 'validate', '--file', csv])
  check('退出码 0', r.status === 0, r.stderr)
  check('未写入（verified 仍 0）', readPrinciple(lib, '甲', '甲-PR-001').verified_count === 0)
}

console.log('VR-2 import 5 条 hit → verified=5，I2 一致')
{
  const lib = freshLib('vr2', template)
  const csv = join(TMP, 'vr-5.csv')
  const rows = ['record_id,principle_id,occurred_at,result,project_ref,evidence,recorded_by']
  for (let i = 1; i <= 5; i += 1) rows.push(`VR-${i},甲-PR-001,2026-10-0${i},hit,甲,证据 ${i},manual`)
  writeFileSync(csv, `${rows.join('\n')}\n`)
  const r = run('vr-cli.js', ['--library', lib, 'import', '--file', csv])
  check('退出码 0', r.status === 0, r.stderr)
  const p = readPrinciple(lib, '甲', '甲-PR-001')
  check('records=5', p.verification_records.length === 5)
  check('verified=5', p.verified_count === 5)
  check('violated=0', p.violated_count === 0)
  check('I2 一致', p.verification_records.filter((x) => x.result === 'hit').length === p.verified_count)
  check('备份已生成', existsSync(join(lib, 'data', `.backup-vr-${new Date().toISOString().slice(0, 10)}`)))
}

console.log('VR-3 重复 record_id → 拒绝写入')
{
  const lib = freshLib('vr3', template)
  const csv = join(TMP, 'vr-dup.csv')
  writeFileSync(csv, 'record_id,principle_id,occurred_at,result,project_ref,evidence\nVR-1,甲-PR-001,2026-10-01,hit,甲,A\nVR-1,甲-PR-001,2026-10-02,hit,甲,B\n')
  const r = run('vr-cli.js', ['--library', lib, 'import', '--file', csv])
  check('退出码 1', r.status === 1)
  check('未写入', readPrinciple(lib, '甲', '甲-PR-001').verified_count === 0)
}

console.log('CROSS-1 dry-run 不改数据；CROSS-2 apply 生效 cross=3')
{
  const lib = freshLib('cross1', template)
  const confirm = join(TMP, 'confirm.json')
  writeFileSync(confirm, JSON.stringify({ candidates: [{ principle_id: '甲-PR-001', confirmed: true, pattern_present_project_ids: ['甲', '乙', '丙'] }] }))
  const dry = run('cross-cli.js', ['--library', lib, 'apply', '--confirm', confirm, '--dry-run'])
  check('dry-run 退出码 0', dry.status === 0, dry.stderr)
  check('dry-run 未写入', readPrinciple(lib, '甲', '甲-PR-001').pattern_replication === undefined)
  const apply = run('cross-cli.js', ['--library', lib, 'apply', '--confirm', confirm])
  check('apply 退出码 0', apply.status === 0, apply.stderr)
  const p = readPrinciple(lib, '甲', '甲-PR-001')
  check('pattern_present=3', p.pattern_replication?.pattern_present_project_ids?.length === 3)
  check('cross=3（I3）', p.cross_scenario_count === 3)
  check('last_checked_at 就位', typeof p.pattern_replication?.last_checked_at === 'string')
}

console.log('CROSS-3 未含自身项目 → 校验失败')
{
  const lib = freshLib('cross3', template)
  const confirm = join(TMP, 'confirm-bad.json')
  writeFileSync(confirm, JSON.stringify({ candidates: [{ principle_id: '甲-PR-001', confirmed: true, pattern_present_project_ids: ['乙', '丙'] }] }))
  const r = run('cross-cli.js', ['--library', lib, 'validate', '--confirm', confirm])
  check('退出码 1', r.status === 1)
  check('提示未含自身项目', (r.stdout + r.stderr).includes('未包含自身项目'))
}

console.log('')
console.log(`结果：${passed} 通过，${failures.length} 失败`)
if (failures.length > 0) { console.log(`失败：${failures.join('；')}`); process.exit(1) }
process.exit(0)
