#!/usr/bin/env node
/**
 * dsh-principles-audit · 验证记录（verification_records）回填工具
 *
 * 用途：把「原则复盘器 / 每日三条 / 投后案例复盘」的命中记录，按 I2 口径
 *       回填到 principles.json，并重算 verified_count / violated_count。
 *
 * 用法：
 *   node vr-cli.js --library <root> validate --file <records.jsonl|csv>   # 只校验
 *   node vr-cli.js --library <root> import   --file <records.jsonl|csv>   # 校验+回填（自动备份）
 *   node vr-cli.js --library <root> status  [--id <pid>]                  # 看 I2 一致性 / 距 verified≥5 差距
 *
 * 记录格式（JSONL 每行一条，或 CSV 带表头）：
 *   {"record_id":"VR-2026-0001","principle_id":"<项目B>-PR-001","occurred_at":"2026-10-19",
 *    "result":"hit","project_ref":"<项目B>","scenario":"示例场景",
 *    "evidence":"投后报告：2026Q2 借款展期完成","source":"投后报告","recorded_by":"manual"}
 *
 * 纪律：import 前全量校验；任一错误拒绝写入；写前备份；I2：counts = records 计数，不手填。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { discover } from './core/audit.js'

const RESULTS = ['hit', 'violation', 'inconclusive']
const RECORDED_BY = ['daily_three_review', 'manual', 'v1_pipeline', '']

function parseArgs(argv) {
  const options = {}
  const named = new Map([['--library', 'library'], ['--file', 'file'], ['--id', 'id'], ['--force', 'force']])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (['validate', 'import', 'status'].includes(arg)) options.command = arg
    else if (named.has(arg)) {
      const key = named.get(arg)
      if (key === 'force') { options.force = true; continue }
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

/* ---------------- 解析 ---------------- */

function parseCsv(text) {
  const rows = []
  let field = ''
  let row = []
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1 }
      else if (ch === '"') inQuotes = false
      else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(field); field = ''
      if (row.some((cell) => cell.trim() !== '')) rows.push(row)
      row = []
    } else field += ch
  }
  if (field !== '' || row.length > 0) { row.push(field); if (row.some((cell) => cell.trim() !== '')) rows.push(row) }
  return rows
}

function parseRecords(text) {
  const trimmed = text.trim()
  if (trimmed === '') return []
  if (trimmed.startsWith('{')) {
    return trimmed.split('\n').filter((line) => line.trim() !== '').map((line, index) => {
      try { return JSON.parse(line) } catch (error) { throw new Error(`第 ${index + 1} 行不是合法 JSON：${error.message}`) }
    })
  }
  const rows = parseCsv(text)
  if (rows.length === 0) return []
  const header = rows[0].map((cell) => cell.trim())
  return rows.slice(1).map((cells) => Object.fromEntries(header.map((key, index) => [key, (cells[index] ?? '').trim()])))
}

/* ---------------- 校验 ---------------- */

function validateRecords(records, principlesById, existingIds) {
  const errors = []
  const seen = new Set()
  records.forEach((record, index) => {
    const where = `第 ${index + 1} 条（${record.record_id ?? '?'}）`
    if (typeof record.record_id !== 'string' || !/^VR-[A-Za-z0-9-]+$/.test(record.record_id)) errors.push(`${where}：record_id 需匹配 ^VR-`)
    if (seen.has(record.record_id)) errors.push(`${where}：record_id 在文件内重复`)
    if (existingIds.has(record.record_id)) errors.push(`${where}：record_id 已存在于库内`)
    seen.add(record.record_id)
    if (!principlesById.has(record.principle_id)) errors.push(`${where}：principle_id 不存在：${record.principle_id}`)
    if (typeof record.occurred_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.occurred_at)) errors.push(`${where}：occurred_at 需 YYYY-MM-DD`)
    if (!RESULTS.includes(record.result)) errors.push(`${where}：result 必须是 ${RESULTS.join(' / ')}`)
    if (typeof record.project_ref !== 'string' || record.project_ref.trim() === '') errors.push(`${where}：project_ref 不能为空`)
    if (typeof record.evidence !== 'string' || record.evidence.trim() === '') errors.push(`${where}：evidence 不能为空`)
    if (record.recorded_by !== undefined && !RECORDED_BY.includes(record.recorded_by)) errors.push(`${where}：recorded_by 非法`)
  })
  return errors
}

/* ---------------- 库读写 ---------------- */

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

function today() {
  return new Date().toISOString().slice(0, 10)
}

/* ---------------- 命令 ---------------- */

function main() {
  const options = parseArgs(process.argv.slice(2))
  const library = typeof options.library === 'string' && options.library.trim() !== ''
    ? (isAbsolute(options.library) ? options.library : resolve(process.cwd(), options.library))
    : defaultLibrary()
  if (!existsSync(library)) { console.error(`库不存在：${library}`); return 2 }

  const discovered = discover(library)
  const principles = discovered.datasets.flatMap((dataset) => dataset.principles)
  const byId = new Map(principles.map((principle) => [String(principle.principle_id ?? ''), principle]))

  try {
    if (options.command === 'status') {
      const rows = []
      for (const principle of principles) {
        if (options.id !== undefined && String(principle.principle_id) !== options.id) continue
        const records = Array.isArray(principle.verification_records) ? principle.verification_records : []
        const hits = records.filter((record) => record.result === 'hit').length
        const violations = records.filter((record) => record.result === 'violation').length
        const ok = hits === Number(principle.verified_count ?? 0) && violations === Number(principle.violated_count ?? 0)
        rows.push({ pid: principle.principle_id, records: records.length, hits, violations,
          verified: Number(principle.verified_count ?? 0), violated: Number(principle.violated_count ?? 0), ok })
      }
      if (options.id !== undefined && rows.length === 0) { console.error(`找不到 ${options.id}`); return 1 }
      console.log('principle_id            记录  命中  违背  verified  violated  I2一致  距verified≥5')
      for (const row of rows) {
        console.log(`${String(row.pid).padEnd(24)} ${String(row.records).padStart(4)} ${String(row.hits).padStart(5)} ${String(row.violations).padStart(5)} ${String(row.verified).padStart(9)} ${String(row.violated).padStart(9)}  ${row.ok ? '✓' : '✗'}      ${Math.max(0, 5 - row.hits)}`)
      }
      return 0
    }

    if (!options.file) { console.error('缺少 --file <records.jsonl|csv>'); return 2 }
    const file = isAbsolute(options.file) ? options.file : resolve(process.cwd(), options.file)
    if (!existsSync(file)) { console.error(`文件不存在：${file}`); return 2 }
    const records = parseRecords(readFileSync(file, 'utf8'))

    const existingIds = new Set()
    for (const principle of principles) {
      for (const record of principle.verification_records ?? []) existingIds.add(record.record_id)
    }
    const errors = validateRecords(records, byId, existingIds)
    if (errors.length > 0) {
      console.error(`校验失败（${errors.length} 处）：`)
      for (const error of errors.slice(0, 20)) console.error(`  ✗ ${error}`)
      return 1
    }
    console.log(`✓ 校验通过：${records.length} 条记录`)

    if (options.command === 'validate') return 0

    // import：备份 → 按 principle 分组追加 → 重算 counts（I2）
    const byPid = new Map()
    for (const record of records) {
      const list = byPid.get(record.principle_id) ?? []
      list.push(record)
      byPid.set(record.principle_id, list)
    }
    const backupDir = resolve(library, 'data', `.backup-vr-${today()}`)
    mkdirSync(backupDir, { recursive: true })
    const touched = []
    for (const [pid, rows] of byPid) {
      const principle = byId.get(pid)
      const filePath = principle.__file
      const { data, entry } = loadEntry(filePath, pid)
      const backupName = `${String(pid).replace(/[\\/]/g, '_')}.principles.json`
      if (!existsSync(resolve(backupDir, backupName))) {
        writeFileSync(resolve(backupDir, backupName), JSON.stringify(data, null, 2))
      }
      entry.verification_records = [...(entry.verification_records ?? []), ...rows]
      entry.verified_count = entry.verification_records.filter((record) => record.result === 'hit').length
      entry.violated_count = entry.verification_records.filter((record) => record.result === 'violation').length
      entry.updated_at = today()
      saveEntry(filePath, data)
      touched.push({ pid, appended: rows.length, verified: entry.verified_count, violated: entry.violated_count })
    }
    console.log(`✓ 已回填 ${touched.length} 条原则：`)
    for (const row of touched) {
      console.log(`  ${row.pid}：+${row.appended} 条 → verified=${row.verified} violated=${row.violated}`)
    }
    console.log(`  备份：${backupDir}`)
    return 0
  } catch (error) {
    console.error(String(error?.message ?? error))
    return 1
  }
}

process.exit(main())
