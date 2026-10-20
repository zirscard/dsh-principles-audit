#!/usr/bin/env node
/**
 * dsh-principles-audit · 封版操作端 CLI（v0.4 P0）
 *
 * 用法（--library 默认 <principle-library>）：
 *   node seal-cli.js --library <root> hash --id <pid>                       # 查看规范字段哈希
 *   node seal-cli.js --library <root> eligible --id <pid>                   # 查看封版判据
 *   node seal-cli.js --library <root> seal --id <pid> --actor <id> \
 *        [--track-record <t>] [--evidence a,b] [--review-years 1]           # 封版（判据不过会拒绝）
 *   node seal-cli.js --library <root> overturn --id <pid> --mode revise|split|retire \
 *        --trigger <t> --evidence a,b --diagnosis "..." --actor <id>        # 颠覆（先账本后 JSON，I11）
 *   node seal-cli.js --library <root> reaffirm --id <pid> --actor <id>      # 到期复核
 *   node seal-cli.js --library <root> verify                                 # 校验账本哈希链
 *
 * 纪律：
 * - 先写 state/principle-ledger.jsonl（追加式哈希链），再改 principles.json（I11）。
 * - 封版条目只读；要改只能 overturn 继任（revise 升版本 / split 拆分 / retire 退休）。
 * - retire 的 supersession 挂在原条目上；revise/split 挂在继任条目上。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { discover } from './core/audit.js'
import {
  appendEvent, buildSeal, buildSupersession, contentHash, ledgerPath,
  readLedger, sealEligibility, verifyChain,
} from './core/seal.js'

function parseArgs(argv) {
  const options = { evidence: [] }
  const named = new Map([
    ['--library', 'library'], ['--id', 'id'], ['--actor', 'actor'], ['--track-record', 'trackRecord'],
    ['--evidence', 'evidenceRaw'], ['--review-years', 'reviewYears'], ['--mode', 'mode'],
    ['--trigger', 'trigger'], ['--diagnosis', 'diagnosis'], ['--diff', 'diff'], ['--force', 'force'],
  ])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === 'hash' || arg === 'eligible' || arg === 'seal' || arg === 'overturn' || arg === 'reaffirm' || arg === 'verify') {
      options.command = arg
    } else if (named.has(arg)) {
      const key = named.get(arg)
      if (key === 'force') { options.force = true; continue }
      const value = argv[i + 1]
      i += 1
      if (key === 'evidenceRaw') options.evidence = String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
      else if (key === 'reviewYears') options.reviewYears = Number(value)
      else options[key] = value
    }
  }
  return options
}

function defaultLibrary() {
  const override = process.env.DSH_PRINCIPLES_AUDIT_DIR
  if (typeof override === 'string' && override.trim() !== '') return override
  return resolve(process.env.DSH_PRINCIPLES_AUDIT_DIR || join(process.cwd(), 'principle-dashboard-v2'))
}

/** 在库里定位原则：返回 {dataset, principle}（principle 是 discover 的副本，仅用于读取）。 */
function locate(library, id) {
  const discovered = discover(library)
  for (const dataset of discovered.datasets) {
    const principle = dataset.principles.find((item) => String(item.principle_id ?? '') === String(id))
    if (principle !== undefined) return { discovered, dataset, principle }
  }
  throw new Error(`找不到原则 ${id}（库：${discovered.input}）`)
}

/** 重新读文件并按 principle_id 找到原始条目（可变引用）。 */
function loadEntry(file, id) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  const list = Array.isArray(data) ? data : data.principles
  const index = list.findIndex((item) => String(item.principle_id ?? '') === String(id))
  if (index < 0) throw new Error(`文件 ${file} 中找不到 ${id}`)
  return { data, list, index, entry: list[index] }
}

function saveEntry(file, data) {
  const body = Array.isArray(data) ? data : { ...data, principles: data.principles }
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
}

function bumpVersion(version) {
  const match = /^v(\d+)\.(\d+)$/.exec(String(version ?? ''))
  if (match === null) return 'v1.1'
  return `v${Number(match[1])}.${Number(match[2]) + 1}`
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const library = typeof options.library === 'string' && options.library.trim() !== ''
    ? (isAbsolute(options.library) ? options.library : resolve(process.cwd(), options.library))
    : defaultLibrary()
  if (!existsSync(library)) {
    console.error(`库不存在：${library}`)
    return 2
  }
  if (options.command === undefined) {
    console.error('缺少命令：hash / eligible / seal / overturn / reaffirm / verify')
    return 2
  }

  try {
    if (options.command === 'verify') {
      const path = ledgerPath(resolve(library))
      if (!existsSync(path)) {
        console.log(`账本不存在：${path}（无封版记录时属正常）`)
        return 0
      }
      const { events, errors } = readLedger(path)
      const chain = verifyChain(events)
      console.log(`账本：${path}`)
      console.log(`事件 ${events.length} 条 · 坏行 ${errors.length} · 链 ${chain.ok ? '完整' : '断裂'}`)
      for (const problem of chain.problems.slice(0, 10)) console.log(`  ✗ 第 ${problem.lineNo} 行：${problem.reason}`)
      for (const error of errors.slice(0, 5)) console.log(`  ✗ 第 ${error.lineNo} 行：${error.reason}`)
      const last = events[events.length - 1]
      if (last !== undefined) console.log(`末事件 seq=${last.seq} ${last.event} ${last.seal_id ?? ''}`)
      return chain.ok && errors.length === 0 ? 0 : 1
    }

    if (options.id === undefined) {
      console.error('缺少 --id <principle_id>')
      return 2
    }
    const { discovered, principle } = locate(library, options.id)

    if (options.command === 'hash') {
      console.log(contentHash(principle))
      return 0
    }

    if (options.command === 'eligible') {
      const eligibility = sealEligibility(principle)
      console.log(`判据：${JSON.stringify(eligibility.criteria)}`)
      console.log(eligibility.ok ? '✓ 满足封版条件' : `✗ 未满足：${eligibility.missing.join('；')}`)
      return eligibility.ok ? 0 : 1
    }

    if (options.command === 'seal') {
      if (!options.actor) {
        console.error('缺少 --actor <id>（签核人，I7）')
        return 2
      }
      const eligibility = sealEligibility(principle)
      if (!eligibility.ok && options.force !== true) {
        console.error(`封版判据未满足，拒绝（--force 可强制，但审计会报 seal-eligibility）：${eligibility.missing.join('；')}`)
        return 1
      }
      const seal = buildSeal(principle, { id: options.actor, track_record: options.trackRecord }, {
        evidenceRefs: options.evidence,
        reviewYears: options.reviewYears,
        criteria: eligibility.criteria,
      })
      appendEvent(resolve(library), {
        event: 'seal', principle_id: principle.principle_id, version: principle.version,
        seal_id: seal.seal_id, content_hash: seal.content_hash, actor: options.actor,
        note: options.force === true && !eligibility.ok ? '强制封版：判据未满足' : undefined,
      })
      const file = principle.__file
      const { data, entry } = loadEntry(file, options.id)
      entry.seal = seal
      entry.lifecycle_state = 'sealed'
      entry.status = '已封版'
      saveEntry(file, data)
      console.log(`✓ 已封版 ${seal.seal_id}`)
      console.log(`  content_hash=${seal.content_hash}`)
      console.log(`  next_review_at=${seal.next_review_at}（到期须 reaffirm 或颠覆）`)
      console.log(`  账本：${ledgerPath(resolve(library))}`)
      return 0
    }

    if (options.command === 'overturn') {
      if (principle?.seal === undefined || principle.seal === null) {
        console.error(`${options.id} 没有封版记录，只能普通修订（升 version + version_history）`)
        return 1
      }
      const record = buildSupersession({
        supersedes: principle.seal.seal_id,
        mode: options.mode,
        trigger: options.trigger,
        evidenceRefs: options.evidence,
        diagnosis: options.diagnosis,
        diffSummary: options.diff ?? null,
        actor: { id: options.actor, track_record: options.trackRecord },
      })
      appendEvent(resolve(library), {
        event: 'overturn', principle_id: principle.principle_id, version: principle.version,
        seal_id: principle.seal.seal_id, supersedes: record.supersedes, mode: record.mode,
        actor: options.actor, note: record.diagnosis.slice(0, 80),
      })
      const file = principle.__file
      const { data, list, index, entry } = loadEntry(file, options.id)
      if (record.mode === 'retire') {
        entry.supersession = record
        entry.lifecycle_state = 'retired'
        entry.status = '已归档'
        saveEntry(file, data)
        console.log(`✓ 已退休（retire）：${record.supersedes} → 无继任`)
      } else if (record.mode === 'revise') {
        const newVersion = bumpVersion(entry.version)
        entry.lifecycle_state = 'overturned'
        entry.status = '已颠覆'
        const { seal, __file, __project, __index, ...rest } = entry
        const successor = {
          ...rest,
          version: newVersion,
          lifecycle_state: 'active',
          status: '活跃',
          supersession: record,
          version_history: [
            ...(Array.isArray(entry.version_history) ? entry.version_history : []),
            {
              version: newVersion,
              changed_at: today(),
              changed_by: options.actor ?? null,
              change_reason: `颠覆继任：${String(options.diagnosis ?? '').slice(0, 60)}`,
              diff_summary: options.diff ?? null,
              supersedes_version: entry.version,
            },
          ],
        }
        list.splice(index + 1, 0, successor)
        saveEntry(file, data)
        console.log(`✓ 已颠覆并继任：${record.supersedes} → ${entry.principle_id}@${newVersion}（active）`)
        console.log(`  旧条目转 overturned 终态；请编辑继任条目的规范字段后再跑 principles_audit`)
      } else {
        console.error('split 模式请手工拆分后，把 supersession 挂到各子原则上（P0 CLI 不自动拆）')
        return 2
      }
      console.log(`  账本：${ledgerPath(resolve(library))}`)
      return 0
    }

    if (options.command === 'reaffirm') {
      if (principle?.seal === undefined || principle.seal === null) {
        console.error(`${options.id} 没有封版记录`)
        return 1
      }
      appendEvent(resolve(library), {
        event: 'reaffirm', principle_id: principle.principle_id, version: principle.version,
        seal_id: principle.seal.seal_id, actor: options.actor,
      })
      const file = principle.__file
      const { data, entry } = loadEntry(file, options.id)
      const years = Number(options.reviewYears ?? 1)
      entry.seal.reaffirmed_at = today()
      entry.seal.next_review_at = new Date(Date.now() + years * 365.25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      saveEntry(file, data)
      console.log(`✓ 已复核 ${entry.seal.seal_id}，下一复核日 ${entry.seal.next_review_at}`)
      return 0
    }

    console.error(`未知命令：${options.command}`)
    return 2
  } catch (error) {
    console.error(String(error?.message ?? error))
    return 1
  }
}

process.exit(main())
