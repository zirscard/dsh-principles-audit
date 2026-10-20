#!/usr/bin/env node
/**
 * dsh-principles-audit · 跨场景同模式回填工具（pattern_replication）
 *
 * 流程：建议清单 → 人工在 confirm JSON 里把 confirmed 改成 true（可增删项目）→ apply。
 *
 * 用法：
 *   node cross-cli.js --library <root> validate --confirm <confirm.json>   # 只校验
 *   node cross-cli.js --library <root> apply    --confirm <confirm.json> [--dry-run]
 *
 * 纪律：
 * - 只回填 confirmed=true 的候选；未确认的一律不动。
 * - 写前备份（data/.backup-cross-<日期>/）。
 * - cross_scenario_count = pattern_present_project_ids 去重数（I3），自动重算。
 * - 必须包含原则自身所在项目（校验会提示）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { discover } from './core/audit.js'

function parseArgs(argv) {
  const options = {}
  const named = new Map([['--library', 'library'], ['--confirm', 'confirm'], ['--dry-run', 'dryRun']])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (['validate', 'apply'].includes(arg)) options.command = arg
    else if (named.has(arg)) {
      const key = named.get(arg)
      if (key === 'dryRun') { options.dryRun = true; continue }
      options[key] = argv[i + 1]
      i += 1
    }
  }
  return options
}

function defaultLibrary() {
  const override = process.env.DSH_PRINCIPLES_AUDIT_DIR
  if (typeof override === 'string' && override.trim() !== '') return override
  return resolve(process.env.DSH_PRINCIPLES_AUDIT_DIR || join(process.cwd(), 'principle-dashboard-v2'))
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function loadEntry(file, principleId) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const list = Array.isArray(data) ? data : data.principles
  const entry = list.find((item) => String(item.principle_id ?? '') === String(principleId))
  if (entry === undefined) throw new Error(`文件 ${file} 中找不到 ${principleId}`)
  return { data, entry }
}

function saveEntry(file, data) {
  writeFileSync(file, `${JSON.stringify(Array.isArray(data) ? data : { ...data, principles: data.principles }, null, 2)}\n`, 'utf8')
}

function ownProject(principle) {
  return String(principle.__project ?? principle.project ?? '').trim()
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const library = typeof options.library === 'string' && options.library.trim() !== ''
    ? (isAbsolute(options.library) ? options.library : resolve(process.cwd(), options.library))
    : defaultLibrary()
  if (!existsSync(library)) { console.error(`库不存在：${library}`); return 2 }
  if (!options.confirm) { console.error('缺少 --confirm <confirm.json>'); return 2 }
  const confirmFile = isAbsolute(options.confirm) ? options.confirm : resolve(process.cwd(), options.confirm)
  if (!existsSync(confirmFile)) { console.error(`确认文件不存在：${confirmFile}`); return 2 }

  const discovered = discover(library)
  const principles = new Map(discovered.datasets.flatMap((dataset) => dataset.principles).map((p) => [String(p.principle_id ?? ''), p]))
  const confirm = JSON.parse(readFileSync(confirmFile, 'utf8'))
  const candidates = Array.isArray(confirm.candidates) ? confirm.candidates : []

  try {
    if (options.command === 'validate') {
      let errors = 0
      for (const candidate of candidates) {
        const principle = principles.get(String(candidate.principle_id))
        if (principle === undefined) { console.error(`✗ 找不到原则 ${candidate.principle_id}`); errors += 1; continue }
        const projects = Array.isArray(candidate.pattern_present_project_ids) ? candidate.pattern_present_project_ids.map(String) : []
        if (projects.length === 0) { console.error(`✗ ${candidate.principle_id}：project 列表为空`); errors += 1; continue }
        const own = ownProject(principle)
        if (own !== '' && !projects.includes(own)) { console.error(`✗ ${candidate.principle_id}：列表未包含自身项目「${own}」`); errors += 1 }
        if (new Set(projects).size !== projects.length) { console.error(`✗ ${candidate.principle_id}：project 列表有重复`); errors += 1 }
        const cross = new Set(projects).size
        console.log(`✓ ${candidate.principle_id}：${cross} 个项目${candidate.confirmed === true ? '（已确认）' : '（未确认，不会回填）'}${cross < 3 ? ' · 未达 cross≥3' : ''}`)
      }
      console.log(errors === 0 ? '校验通过' : `校验失败：${errors} 处`)
      return errors === 0 ? 0 : 1
    }

    if (options.command !== 'apply') { console.error('命令：validate | apply'); return 2 }

    const confirmed = candidates.filter((candidate) => candidate.confirmed === true)
    if (confirmed.length === 0) {
      console.log('没有 confirmed=true 的候选；未做任何修改。把要回填的条目的 "confirmed" 改成 true 再跑。')
      return 0
    }
    const backupDir = resolve(library, 'data', `.backup-cross-${today()}`)
    if (!options.dryRun) mkdirSync(backupDir, { recursive: true })
    const applied = []
    for (const candidate of confirmed) {
      const principle = principles.get(String(candidate.principle_id))
      if (principle === undefined) { console.error(`✗ 找不到 ${candidate.principle_id}，跳过`); continue }
      const projects = [...new Set((candidate.pattern_present_project_ids ?? []).map(String))].filter((item) => item.trim() !== '')
      if (projects.length === 0) { console.error(`✗ ${candidate.principle_id} 列表为空，跳过`); continue }
      const cross = projects.length
      const pattern = {
        pattern_present_project_ids: projects,
        pattern_absent_project_ids: candidate.pattern_absent_project_ids ?? [],
        counter_case_search: {
          scope: candidate.scope ?? '13 在投项目（V1.5 映射）',
          performed_at: candidate.performed_at ?? today(),
          result: candidate.counter_case_result ?? 'found',
          found_case_ids: candidate.found_case_ids ?? [],
        },
        transferability: candidate.transferability ?? 'cross_container',
        evidence_strength: candidate.evidence_strength ?? 'medium',
        last_checked_at: today(),
      }
      if (options.dryRun) {
        console.log(`[dry-run] ${candidate.principle_id}：cross_scenario_count ${principle.cross_scenario_count ?? 0} → ${cross}；项目 ${projects.join('、')}`)
        continue
      }
      const file = principle.__file
      const { data, entry } = loadEntry(file, candidate.principle_id)
      const backupName = `${String(candidate.principle_id).replace(/[\\/]/g, '_')}.principles.json`
      if (!existsSync(resolve(backupDir, backupName))) {
        writeFileSync(resolve(backupDir, backupName), JSON.stringify(data, null, 2))
      }
      entry.pattern_replication = pattern
      entry.cross_scenario_count = cross
      entry.updated_at = today()
      saveEntry(file, data)
      applied.push({ pid: candidate.principle_id, cross })
    }
    if (applied.length > 0) {
      console.log(`✓ 已回填 ${applied.length} 条：`)
      for (const row of applied) console.log(`  ${row.pid}：cross_scenario_count=${row.cross}`)
      console.log(`  备份：${backupDir}`)
    }
    return 0
  } catch (error) {
    console.error(String(error?.message ?? error))
    return 1
  }
}

process.exit(main())
