/**
 * dsh-principles-audit · 封版（Seal）与账本（Ledger）核心库
 *
 * v0.4：实现「封版 + 继任 + 哈希链账本」。设计见
 * <internal-docs>/docs/principle-seal-and-supersession-v0.1.md
 * 与 principles.schema.json 的 I7–I11 不变式。
 *
 * 纯 Node ESM，零运行时依赖。本模块不 import audit.js（避免循环依赖）；
 * 操作端 CLI 自行组合 discover() 与本模块。
 *
 * @module dsh-principles-audit/core/seal
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const GENESIS_HASH = `sha256:${'0'.repeat(64)}`
export const LEDGER_NAME = 'principle-ledger.jsonl'

/** 事件负载的规范键序（写端与校验端共用，保证哈希一致）。 */
const EVENT_KEYS = ['seq', 'ts', 'event', 'principle_id', 'version', 'seal_id', 'content_hash', 'supersedes', 'mode', 'actor', 'note']

/* ------------------------------------------------------------------ */
/* 内容哈希（I8）                                                        */
/* ------------------------------------------------------------------ */

/** 规范字段集合：封版后这些字段的任何变更都视为非法（要改只能继任）。 */
export function canonicalNormative(principle) {
  return JSON.stringify({
    name: principle?.name ?? '',
    causal_statement: principle?.causal_statement ?? '',
    applicable_conditions: principle?.applicable_conditions ?? '',
    counter_examples: principle?.counter_examples ?? '',
    evidence: Array.isArray(principle?.evidence) ? principle.evidence : [],
    dimension_id: principle?.dimension_id ?? null,
  })
}

export function contentHash(principle) {
  return `sha256:${createHash('sha256').update(canonicalNormative(principle), 'utf8').digest('hex')}`
}

export function isValidHash(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

/* ------------------------------------------------------------------ */
/* 封版判据（I7，沿用 I1 阈值口径）                                        */
/* ------------------------------------------------------------------ */

export const SEAL_THRESHOLDS = {
  outcome_labels: 5,
  verified: 5,
  cross_scenario: 3,
  real_counter_example: 1,
  open_challenges: 0,
}

/** 从原则现数据计算判据快照。open_challenges 默认 0（M3 挑战侧维护，可被 operator 覆盖）。 */
export function computeCriteria(principle, overrides = {}) {
  const falsification = principle?.falsification
  const cases = Array.isArray(falsification?.cases) ? falsification.cases : []
  const criteria = {
    outcome_labels: Number(principle?.outcome_validation?.label_count ?? 0),
    verified: Number(principle?.verified_count ?? 0),
    cross_scenario: Number(principle?.cross_scenario_count ?? 0),
    real_counter_example: cases.filter((entry) => entry?.type === 'real_case').length,
    open_challenges: 0,
  }
  return { ...criteria, ...overrides }
}

export function sealEligibility(principle, thresholds = SEAL_THRESHOLDS, overrides = {}) {
  const criteria = computeCriteria(principle, overrides)
  const missing = []
  for (const [key, threshold] of Object.entries(thresholds)) {
    if (key === 'open_challenges') {
      if (criteria[key] > threshold) missing.push(`open_challenges=${criteria[key]}>${threshold}`)
    } else if (criteria[key] < threshold) {
      missing.push(`${key}=${criteria[key]}<${threshold}`)
    }
  }
  if (String(principle?.applicable_conditions ?? '').trim() === '') missing.push('applicable_conditions 为空（I5）')
  if (String(principle?.counter_examples ?? '').trim() === '') missing.push('counter_examples 为空（I5）')
  return { ok: missing.length === 0, criteria, missing }
}

/* ------------------------------------------------------------------ */
/* 记录构造                                                              */
/* ------------------------------------------------------------------ */

export function buildSealId(principle) {
  const version = String(principle?.version ?? '').replace(/^v/, 'v')
  return `SEAL-${principle.principle_id}-${version}`
}

export function buildSeal(principle, actor, options = {}) {
  const eligibility = sealEligibility(principle, options.thresholds, options.criteriaOverrides)
  if (!eligibility.ok) {
    throw new Error(`封版判据未满足（I7）：${eligibility.missing.join('；')}`)
  }
  const sealedAt = options.sealedAt ?? new Date().toISOString().slice(0, 10)
  const reviewYears = Number(options.reviewYears ?? 1)
  const nextReviewAt = options.nextReviewAt
    ?? new Date(Date.now() + reviewYears * 365.25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  return {
    seal_id: buildSealId(principle),
    content_hash: contentHash(principle),
    sealed_at: sealedAt,
    sealed_by: { id: String(actor?.id ?? ''), track_record: actor?.track_record ?? null },
    criteria: options.criteria ?? eligibility.criteria,
    evidence_refs: Array.isArray(options.evidenceRefs) ? options.evidenceRefs : [],
    next_review_at: nextReviewAt,
    reaffirmed_at: null,
  }
}

export function buildSupersession(input) {
  const {
    supersedes, mode, trigger, evidenceRefs, diagnosis,
    actor, decidedAt, diffSummary = null, impact = null,
  } = input
  if (typeof supersedes !== 'string' || !/^SEAL-/.test(supersedes)) throw new Error('supersedes 必须以 SEAL- 开头')
  if (!['revise', 'split', 'retire'].includes(mode)) throw new Error('mode 必须是 revise / split / retire')
  if (!['counter_example', 'violation', 'regime_change', 'm3_challenge', 'review_due'].includes(trigger)) {
    throw new Error('trigger 必须是 counter_example / violation / regime_change / m3_challenge / review_due')
  }
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) throw new Error('evidence_refs 不能为空（I9）')
  if (typeof diagnosis !== 'string' || diagnosis.trim() === '') throw new Error('diagnosis 必填（I9）')
  if (!actor?.id) throw new Error('decided_by.id 必填（I9）')
  return {
    supersedes,
    mode,
    trigger,
    evidence_refs: evidenceRefs.map(String),
    diagnosis,
    diff_summary: diffSummary,
    decided_by: { id: String(actor.id), track_record: actor.track_record ?? null },
    decided_at: decidedAt ?? new Date().toISOString().slice(0, 10),
    impact,
  }
}

/* ------------------------------------------------------------------ */
/* 账本（I11）：追加式哈希链                                               */
/* ------------------------------------------------------------------ */

export function ledgerPath(root) {
  return join(root, 'state', LEDGER_NAME)
}

/** 读账本；坏行记入 errors（不抛异常，交由校验方定级）。 */
export function readLedger(path) {
  if (!existsSync(path)) return { events: [], errors: [] }
  const lines = readFileSync(path, 'utf8').split('\n')
  const events = []
  const errors = []
  lines.forEach((line, index) => {
    if (line.trim() === '') return
    try {
      events.push({ lineNo: index + 1, ...JSON.parse(line) })
    } catch {
      errors.push({ lineNo: index + 1, reason: 'JSON 解析失败' })
    }
  })
  return { events, errors }
}

function eventPayload(evt) {
  const payload = {}
  for (const key of EVENT_KEYS) {
    if (evt[key] !== undefined) payload[key] = evt[key]
  }
  return payload
}

export function eventHash(hashPrev, evt) {
  return `sha256:${createHash('sha256').update(String(hashPrev) + JSON.stringify(eventPayload(evt)), 'utf8').digest('hex')}`
}

/**
 * 校验哈希链：seq 连续、hash_prev 接链、hash_self 与内容一致。
 * @returns {{ok: boolean, problems: object[], lastHash: string, nextSeq: number, sealEvents: Map}}
 */
export function verifyChain(events) {
  const problems = []
  let expectedSeq = 1
  let prev = GENESIS_HASH
  const sealEvents = new Map()
  for (const evt of events) {
    if (evt.seq !== expectedSeq) {
      problems.push({ lineNo: evt.lineNo, reason: `seq 跳号：期望 ${expectedSeq}，实际 ${evt.seq}` })
      expectedSeq = typeof evt.seq === 'number' ? evt.seq : expectedSeq
    }
    if (evt.hash_prev !== prev) {
      problems.push({ lineNo: evt.lineNo, reason: `hash_prev 不接链：期望 ${prev}，实际 ${String(evt.hash_prev)}` })
    }
    const recomputed = eventHash(evt.hash_prev ?? GENESIS_HASH, evt)
    if (evt.hash_self !== recomputed) {
      problems.push({ lineNo: evt.lineNo, reason: 'hash_self 与事件内容不符（篡改或格式漂移）' })
    }
    prev = typeof evt.hash_self === 'string' ? evt.hash_self : prev
    expectedSeq += 1
    if (evt.event === 'seal' && typeof evt.seal_id === 'string') sealEvents.set(evt.seal_id, evt)
  }
  return { ok: problems.length === 0, problems, lastHash: prev, nextSeq: expectedSeq, sealEvents }
}

/** 追加一个事件（先验链，断了拒绝写）。返回 {seq, hash_self}。 */
export function appendEvent(root, evt) {
  const path = ledgerPath(root)
  mkdirSync(dirname(path), { recursive: true })
  const { events } = readLedger(path)
  const chain = verifyChain(events)
  if (!chain.ok) {
    throw new Error(`账本已断链，拒绝追加（I11）：第 ${chain.problems[0]?.lineNo} 行 ${chain.problems[0]?.reason}`)
  }
  const record = {}
  for (const key of EVENT_KEYS) {
    if (key === 'seq') record.seq = chain.nextSeq
    else if (evt[key] !== undefined) record[key] = evt[key]
  }
  if (record.ts === undefined) record.ts = new Date().toISOString()
  const hashSelf = eventHash(chain.lastHash, record)
  const line = JSON.stringify({ ...record, hash_prev: chain.lastHash, hash_self: hashSelf })
  writeFileSync(path, `${line}\n`, { flag: 'a' })
  return { seq: record.seq, hash_self: hashSelf }
}
