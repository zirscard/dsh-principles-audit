/**
 * dsh-principles-audit · 原则审查引擎
 *
 * 纯 Node ESM，零运行时依赖。输入是「原则库」目录（V2 看板根目录或 data/），
 * 或单个 principles.json；输出分级 findings + markdown/JSON 报告。
 *
 * 设计原则：
 * - 只读输入，不修改任何原则数据；
 * - 检查项都能给出可复核的证据（文件 / principle_id / 字段）；
 * - 找不到 V1.5 维度映射时降级，不因为缺映射而报错。
 *
 * @module dsh-principles-audit/core/audit
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { contentHash, isValidHash, ledgerPath, readLedger, sealEligibility, verifyChain } from './seal.js'

export const VERSION = '0.3.0'

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 }
const SEVERITY_LABEL = { critical: '严重', warning: '警告', info: '提示' }
const MAX_PER_CODE = 40

const DEFAULT_SCORING = {
  base_default: 0.6,
  verified_step: 0.05,
  violation_penalty: 0.1,
  cross_scenario_step: 0.02,
  max: 0.95,
  min: 0.2,
  status_rules: {
    archive_when: { violations_gte: 3, confidence_lt: 0.4 },
    watch_when: { violations_gte: 1, confidence_lt: 0.6 },
    active_otherwise: true,
  },
  status_labels: { active: '活跃', watch: '稳定观察', archive: '已归档' },
  v1_status_map: {
    活跃: 'active',
    active: 'active',
    稳定观察: 'watch',
    观察: 'watch',
    watch: 'watch',
    已归档: 'archive',
    归档: 'archive',
    archive: 'archive',
    待验证: 'watch',
    需修正: 'watch',
    proposed: 'watch',
    replicated: 'active',
    needs_revision: 'watch',
    retired: 'archive',
    已封版: 'sealed',
    sealed: 'sealed',
    已颠覆: 'overturned',
    overturned: 'overturned',
  },
}

const STATUS_ALIASES = {
  活跃: 'active',
  稳定观察: 'watch',
  观察: 'watch',
  已归档: 'archive',
  归档: 'archive',
  active: 'active',
  watch: 'watch',
  archive: 'archive',
  proposed: 'watch',
  replicated: 'active',
  needs_revision: 'watch',
  retired: 'archive',
  已封版: 'sealed',
  sealed: 'sealed',
  已颠覆: 'overturned',
  overturned: 'overturned',
}

/** 终态/封版态：不参与「状态 vs 置信度」一致性核对（该规则只对活跃/观察有意义）。 */
const TERMINAL_LIFECYCLE = new Set(['sealed', 'overturned', 'archive'])

const REQUIRED_FIELDS = [
  { key: 'principle_id', severity: 'critical', label: 'principle_id' },
  { key: 'name', severity: 'critical', label: 'name（原则名）' },
  { key: 'causal_statement', severity: 'critical', label: 'causal_statement（因果句）' },
  { key: 'applicable_conditions', severity: 'warning', label: 'applicable_conditions（适用边界）' },
  { key: 'counter_examples', severity: 'warning', label: 'counter_examples（反例）' },
  { key: 'evidence', severity: 'warning', label: 'evidence（证据）' },
  { key: 'confidence', severity: 'warning', label: 'confidence（置信度）' },
  { key: 'status', severity: 'warning', label: 'status（状态）' },
  { key: 'updated_at', severity: 'info', label: 'updated_at（最近复核）' },
  { key: 'version', severity: 'info', label: 'version（版本）' },
]

/* ------------------------------------------------------------------ */
/* 读取与数据发现                                                       */
/* ------------------------------------------------------------------ */

function readJson(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`无法读取 ${file}: ${error?.message ?? error}`)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`JSON 解析失败 ${file}: ${error?.message ?? error}`)
  }
}

function inferProject(file) {
  const parts = file.split(/[\\/]/)
  const index = parts.lastIndexOf('projects')
  return index >= 0 && parts[index + 1] !== undefined ? parts[index + 1] : null
}

function loadDataset(file, meta = {}) {
  const data = readJson(file)
  const list = Array.isArray(data) ? data : Array.isArray(data?.principles) ? data.principles : null
  if (list === null) throw new Error(`缺少 principles[]：${file}`)
  const project = meta.project ?? inferProject(file)
  return {
    file,
    source: meta.source ?? 'single',
    project,
    generation_notes: typeof data?.generation_notes === 'string' ? data.generation_notes : '',
    principles: list.map((principle, index) => ({
      ...principle,
      __file: file,
      __project: principle?.project ?? project,
      __index: index,
    })),
  }
}

/**
 * 发现输入下的所有 principles.json。
 * @param {string} inputPath 目录（V2 根 / data / 单项目）或 JSON 文件
 */
export function discover(inputPath) {
  let abs = resolve(inputPath)
  let info
  try {
    info = statSync(abs)
  } catch {
    throw new Error(`路径不存在：${abs}`)
  }
  try {
    abs = realpathSync(abs) // 解析符号链接（原则库可能是指向实际模块目录的软链）
  } catch {
    /* 解析失败时保留原路径 */
  }

  const datasets = []
  let root = abs
  if (info.isFile()) {
    datasets.push(loadDataset(abs))
    root = dirname(abs)
  } else {
    const dataDir = basename(abs) === 'data' ? abs : join(abs, 'data')
    const aggregate = join(dataDir, 'v1-input', 'principles.json')
    if (existsSync(aggregate)) datasets.push(loadDataset(aggregate, { source: 'v1-input' }))

    const projectsDir = join(dataDir, 'projects')
    if (existsSync(projectsDir)) {
      for (const name of readdirSync(projectsDir).sort()) {
        const file = join(projectsDir, name, 'principles.json')
        if (!existsSync(file)) continue
        datasets.push(loadDataset(file, { source: 'project', project: name }))
      }
    }

    if (datasets.length === 0) {
      for (const file of [join(abs, 'principles.json'), join(abs, 'v1-input', 'principles.json')]) {
        if (existsSync(file)) {
          datasets.push(loadDataset(file))
          break
        }
      }
    }
  }

  if (datasets.length === 0) throw new Error(`没有找到 principles.json：${abs}`)

  return {
    input: abs,
    root,
    datasets,
    mapping: loadMapping(root, abs),
    scoring: loadScoring(root),
  }
}

function loadMapping(root, input) {
  const bases = [root]
  let cursor = root
  for (let i = 0; i < 4; i += 1) {
    cursor = dirname(cursor)
    if (cursor === bases[bases.length - 1]) break
    bases.push(cursor)
  }
  const candidates = []
  for (const base of bases) {
    candidates.push(join(base, 'principle-dimension-mapping.json'))
    candidates.push(join(base, 'principle-dimension-mapping.json'))
    candidates.push(join(base, 'data', 'principle-dimension-mapping.json'))
  }
  candidates.push(join(input, 'principle-dimension-mapping.json'))
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const data = readJson(file)
    if (!data || !Array.isArray(data.principles)) continue
    const byKey = new Map()
    const byName = new Map()
    for (const entry of data.principles) {
      const pid = String(entry?.pid ?? '').trim()
      const project = String(entry?.project ?? '').trim()
      if (pid.length > 0) byKey.set(`${project}|${pid}`, entry)
      const name = normText(entry?.name)
      if (name.length > 0 && !byName.has(name)) byName.set(name, entry)
    }
    return {
      file,
      dimensions: Array.isArray(data.dimensions) ? data.dimensions : [],
      principles: data.principles,
      byKey,
      byName,
    }
  }
  return null
}

function loadScoring(root) {
  const file = join(root, 'config', 'scoring.json')
  if (!existsSync(file)) return { ...DEFAULT_SCORING }
  try {
    const data = readJson(file)
    return {
      ...DEFAULT_SCORING,
      ...data,
      status_rules: { ...DEFAULT_SCORING.status_rules, ...(data?.status_rules ?? {}) },
      status_labels: { ...DEFAULT_SCORING.status_labels, ...(data?.status_labels ?? {}) },
      v1_status_map: { ...DEFAULT_SCORING.v1_status_map, ...(data?.v1_status_map ?? {}) },
    }
  } catch {
    return { ...DEFAULT_SCORING }
  }
}

/* ------------------------------------------------------------------ */
/* 文本工具                                                             */
/* ------------------------------------------------------------------ */

export function normText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

function bigrams(text) {
  const chars = [...text]
  if (chars.length < 2) return new Set(chars)
  const set = new Set()
  for (let i = 0; i < chars.length - 1; i += 1) set.add(chars[i] + chars[i + 1])
  return set
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

function projectLabel(principle) {
  return String(principle.__project ?? principle.project ?? '').trim() || '汇总'
}

function location(principle) {
  const bits = [projectLabel(principle)]
  if (principle.principle_id) bits.push(String(principle.principle_id))
  if (principle.name) bits.push(String(principle.name))
  return bits.join(' · ')
}

function statusOf(raw, scoring) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  const key = String(raw).trim()
  const map = scoring?.v1_status_map ?? DEFAULT_SCORING.v1_status_map
  if (map[key] !== undefined) return map[key]
  return STATUS_ALIASES[key.toLowerCase()] ?? null
}

function expectedStatus(principle, scoring) {
  const rules = scoring?.status_rules ?? DEFAULT_SCORING.status_rules
  const confidence = Number(principle.confidence)
  const violations = Number(principle.violated_count ?? 0)
  const archive = rules.archive_when ?? {}
  const watch = rules.watch_when ?? {}
  if (Number.isFinite(confidence) && violations >= (archive.violations_gte ?? 3) && confidence < (archive.confidence_lt ?? 0.4)) return 'archive'
  if (Number.isFinite(confidence) && violations >= (watch.violations_gte ?? 1) && confidence < (watch.confidence_lt ?? 0.6)) return 'watch'
  return 'active'
}

function monthsSince(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return null
  return (Date.now() - time) / (1000 * 60 * 60 * 24 * 30.44)
}

/* ------------------------------------------------------------------ */
/* 审查门禁与豁免                                                        */
/* ------------------------------------------------------------------ */

const GATE_LABEL = { pass: '通过', warn: '带豁免放行', fail: '阻断' }

function normalizeExemption(entry) {
  const id = entry?.principle_id === undefined || entry?.principle_id === null || String(entry.principle_id).trim() === ''
    ? null
    : String(entry.principle_id).trim()
  return {
    code: String(entry?.code ?? '').trim(),
    principle_id: id,
    owner: typeof entry?.owner === 'string' ? entry.owner : '',
    reason: typeof entry?.reason === 'string' ? entry.reason : '',
    expires_at: typeof entry?.expires_at === 'string' ? entry.expires_at.trim() : '',
  }
}

/**
 * 豁免表发现顺序：显式参数 > 环境变量 DSH_PRINCIPLES_AUDIT_EXEMPTIONS >
 * <root>/.principles-audit/exemptions.json > 插件自带 exemptions/exemptions.json。
 * applies_to 非空时，必须出现在输入路径里才生效（防止误套到其它原则库）。
 */
function loadExemptions(discovered, options) {
  const candidates = []
  if (typeof options.exemptionsPath === 'string' && options.exemptionsPath.trim() !== '') {
    candidates.push({ file: resolve(options.exemptionsPath), required: true })
  }
  const fromEnv = process.env.DSH_PRINCIPLES_AUDIT_EXEMPTIONS
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') candidates.push({ file: resolve(fromEnv) })
  candidates.push({ file: join(discovered.root, '.principles-audit', 'exemptions.json') })
  if (typeof options.engineRoot === 'string' && options.engineRoot.length > 0) {
    candidates.push({ file: join(options.engineRoot, 'exemptions', 'exemptions.json') })
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate.file)) {
      if (candidate.required === true) throw new Error(`豁免表不存在：${candidate.file}`)
      continue
    }
    const data = readJson(candidate.file)
    const list = Array.isArray(data) ? data : Array.isArray(data?.exemptions) ? data.exemptions : null
    if (list === null) {
      if (candidate.required === true) throw new Error(`豁免表缺少 exemptions[]：${candidate.file}`)
      continue
    }
    const appliesTo = typeof data?.applies_to === 'string' ? data.applies_to.trim() : ''
    if (appliesTo.length > 0 && !discovered.input.includes(appliesTo) && !discovered.root.includes(appliesTo)) continue
    return { file: candidate.file, entries: list.map(normalizeExemption) }
  }
  return null
}

function exemptionExpired(entry, now = Date.now()) {
  if (entry.expires_at === '') return false
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(entry.expires_at) ? `${entry.expires_at}T23:59:59` : entry.expires_at
  const time = Date.parse(raw)
  return Number.isFinite(time) && now > time
}

function matchesExemption(finding, entry) {
  if (entry.code === '' || entry.code !== finding.code) return false
  if (entry.principle_id !== null && entry.principle_id !== String(finding.principle_id ?? '')) return false
  return true
}

/* ------------------------------------------------------------------ */
/* 审查                                                                */
/* ------------------------------------------------------------------ */

/**
 * 对原则库执行审查。
 *
 * @param {object} options
 * @param {string} [options.path] 目录或 JSON 文件；省略时用默认 V2 路径
 * @param {string} [options.outputDir] 报告目录；省略时写 <root>/.principles-audit
 * @param {string[]} [options.checks] 只保留这些 code 的 findings
 * @returns {object}
 */
export function audit(options = {}) {
  const inputPath = options.path ?? defaultInput()
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new Error('缺少 path：请指定 V2 原则库路径，或设置 DSH_PRINCIPLES_AUDIT_DIR')
  }

  const discovered = discover(inputPath)
  const all = discovered.datasets.flatMap((dataset) => dataset.principles)
  const checks = Array.isArray(options.checks) ? options.checks.filter((item) => typeof item === 'string') : []

  /** @type {object[]} */
  const findings = []
  const perCode = new Map()

  function add(finding) {
    if (checks.length > 0 && !checks.includes(finding.code)) return
    const count = perCode.get(finding.code) ?? 0
    if (count >= MAX_PER_CODE) return
    perCode.set(finding.code, count + 1)
    findings.push({
      severity: finding.severity,
      code: finding.code,
      title: finding.title,
      detail: finding.detail ?? '',
      principle_id: finding.principle_id ?? null,
      project: finding.project ?? null,
      file: finding.file ?? null,
      field: finding.field ?? null,
    })
  }

  /* --- 数据集级 ------------------------------------------------- */

  for (const dataset of discovered.datasets) {
    if (dataset.principles.length === 0) {
      add({
        severity: 'critical',
        code: 'dataset-empty',
        title: '数据集为空',
        detail: `${dataset.file} 的 principles[] 为空`,
        file: dataset.file,
        project: dataset.project ?? null,
      })
    }
    if (dataset.generation_notes.trim() === '') {
      add({
        severity: 'info',
        code: 'generation-notes',
        title: '缺少 generation_notes',
        detail: `${dataset.file} 没有说明本批原则的生成口径`,
        file: dataset.file,
        project: dataset.project ?? null,
      })
    }
  }

  /* --- 字段完整性 ----------------------------------------------- */

  for (const principle of all) {
    for (const field of REQUIRED_FIELDS) {
      const value = principle[field.key]
      const missing = value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
      if (!missing) continue
      add({
        severity: field.severity,
        code: 'required-fields',
        title: `缺少 ${field.label}`,
        detail: `${location(principle)} 缺字段 ${field.key}`,
        principle_id: principle.principle_id ?? null,
        project: principle.__project ?? null,
        file: principle.__file ?? null,
        field: field.key,
      })
    }
  }

  /* --- ID 冲突与格式 -------------------------------------------- */

  const byId = new Map()
  for (const principle of all) {
    const id = String(principle.principle_id ?? '').trim()
    if (id === '') continue
    // v0.4：同一 principle_id 的不同 version 是合法版本谱系（封版/继任），只按 pid@version 判冲突
    const key = `${id}@${String(principle.version ?? '').trim()}`
    const list = byId.get(key) ?? []
    list.push(principle)
    byId.set(key, list)
  }

  for (const [id, group] of byId) {
    const names = new Set(group.map((principle) => String(principle.name ?? '').trim()).filter(Boolean))
    if (names.size > 1) {
      const projects = [...new Set(group.map(projectLabel))]
      add({
        severity: 'critical',
        code: 'id-collision',
        title: `principle_id 复用但名称不同：${id}`,
        detail: `出现 ${group.length} 次，覆盖 ${projects.length} 个数据集/项目；名称变体 ${names.size} 种：${[...names].slice(0, 3).join(' / ')}${names.size > 3 ? ' …' : ''}`,
        principle_id: id,
        project: projects.length > 3 ? `${projects.slice(0, 3).join('、')} 等 ${projects.length} 个` : projects.join('、'),
      })
    }
  }

  const legacyIds = new Set()
  const badIds = new Set()
  for (const principle of all) {
    const id = String(principle.principle_id ?? '').trim()
    if (id === '' || legacyIds.has(id) || badIds.has(id)) continue
    if (/^PR-\d{3,4}$/.test(id)) {
      legacyIds.add(id)
      add({
        severity: 'info',
        code: 'legacy-id',
        title: `旧版项目内 ID：${id}`,
        detail: 'V1 v0.3 要求全局 ID `PR-D##-####`；旧 ID 在不同项目会重复，建议迁移时统一重铸',
        principle_id: id,
      })
    } else if (!/^PR-D\d{2}-\d{4}$/.test(id)) {
      badIds.add(id)
      add({
        severity: 'warning',
        code: 'id-format',
        title: `ID 不符合规范：${id}`,
        detail: '期望 `PR-D##-####`（V1 v0.3）或历史 `PR-###`',
        principle_id: id,
      })
    }
  }

  /* --- 边界与证据 ------------------------------------------------ */

  for (const principle of all) {
    if (typeof principle.applicable_conditions === 'string' && principle.applicable_conditions.trim() === '') {
      add({
        severity: 'warning',
        code: 'boundary-missing',
        title: '适用边界为空',
        detail: `${location(principle)}：没有适用边界的句子不是原则，是口号（I5）`,
        principle_id: principle.principle_id ?? null,
        project: principle.__project ?? null,
        file: principle.__file ?? null,
        field: 'applicable_conditions',
      })
    }
    if (typeof principle.counter_examples === 'string' && principle.counter_examples.trim() === '') {
      add({
        severity: 'warning',
        code: 'boundary-missing',
        title: '反例为空',
        detail: `${location(principle)}：没有可能反例的原则不可证伪（I5）`,
        principle_id: principle.principle_id ?? null,
        project: principle.__project ?? null,
        file: principle.__file ?? null,
        field: 'counter_examples',
      })
    }
    if (Array.isArray(principle.evidence) && principle.evidence.length === 0) {
      add({
        severity: 'warning',
        code: 'evidence-missing',
        title: '证据为空',
        detail: `${location(principle)}：evidence[] 为空，无法回溯`,
        principle_id: principle.principle_id ?? null,
        project: principle.__project ?? null,
        file: principle.__file ?? null,
        field: 'evidence',
      })
    }
  }

  /* --- 同名 / 近重复 -------------------------------------------- */

  const byName = new Map()
  for (const principle of all) {
    const key = normText(principle.name)
    if (key === '') continue
    const list = byName.get(key) ?? []
    list.push(principle)
    byName.set(key, list)
  }

  for (const group of byName.values()) {
    if (group.length < 2) continue
    const statements = new Set(group.map((principle) => normText(principle.causal_statement)))
    const projects = [...new Set(group.map(projectLabel))]
    add({
      severity: statements.size > 1 ? 'warning' : 'info',
      code: 'duplicate-name',
      title: statements.size > 1 ? '同名不同义原则' : '重复原则（可合并）',
      detail: `「${group[0].name}」出现 ${group.length} 次，覆盖 ${projects.length} 个数据集/项目${statements.size > 1 ? `；因果句有 ${statements.size} 种` : ''}`,
      principle_id: group[0].principle_id ?? null,
      project: group[0].__project ?? null,
    })
  }

  const items = all.map((principle) => ({
    principle,
    name: bigrams(normText(principle.name)),
    statement: bigrams(normText(principle.causal_statement)),
  }))
  const pairs = []
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const nameScore = jaccard(items[i].name, items[j].name)
      const statementScore = jaccard(items[i].statement, items[j].statement)
      const score = Math.max(nameScore, statementScore)
      if (nameScore < 0.85 && statementScore < 0.8) continue
      pairs.push({ i, j, nameScore, statementScore, score })
    }
  }
  pairs.sort((a, b) => b.score - a.score)
  for (const pair of pairs.slice(0, 12)) {
    const a = items[pair.i].principle
    const b = items[pair.j].principle
    add({
      severity: pair.score >= 0.95 ? 'warning' : 'info',
      code: 'near-duplicate',
      title: `近重复原则（相似度 ${(pair.score * 100).toFixed(0)}%）`,
      detail: `${location(a)} ↔ ${location(b)}；名称 ${(pair.nameScore * 100).toFixed(0)}% / 因果句 ${(pair.statementScore * 100).toFixed(0)}%`,
      principle_id: a.principle_id ?? null,
      project: a.__project ?? null,
    })
  }

  /* --- 状态 / 置信度 / 时效 ------------------------------------- */

  for (const principle of all) {
    const confidence = Number(principle.confidence)
    const actual = statusOf(principle.status, discovered.scoring)
    if (Number.isFinite(confidence) && (confidence < 0.2 || confidence > 0.95)) {
      add({
        severity: 'warning',
        code: 'status-confidence',
        title: '置信度越界',
        detail: `${location(principle)}：confidence=${confidence}，应在 [0.2, 0.95]（I4）`,
        principle_id: principle.principle_id ?? null,
        project: principle.__project ?? null,
        file: principle.__file ?? null,
        field: 'confidence',
      })
    }
    if (actual !== null && !TERMINAL_LIFECYCLE.has(actual)) {
      const expected = expectedStatus(principle, discovered.scoring)
      if (actual !== expected) {
        add({
          severity: 'warning',
          code: 'status-confidence',
          title: '状态与置信度/违背次数不一致',
          detail: `${location(principle)}：status=${principle.status}（${actual}），按 scoring 规则应为 ${expected}`,
          principle_id: principle.principle_id ?? null,
          project: principle.__project ?? null,
          file: principle.__file ?? null,
          field: 'status',
        })
      }
      if (Number(principle.violated_count ?? 0) >= 3 && actual === 'active') {
        add({
          severity: 'warning',
          code: 'status-confidence',
          title: '多次违背仍为活跃',
          detail: `${location(principle)}：violated_count=${principle.violated_count}，建议转观察/归档`,
          principle_id: principle.principle_id ?? null,
          project: principle.__project ?? null,
          file: principle.__file ?? null,
          field: 'violated_count',
        })
      }
    }
    if (Number(principle.verified_count ?? 0) > 0 && !Array.isArray(principle.verification_records)) {
      add({
        severity: 'info',
        code: 'verification-records',
        title: '有验证计数但无 verification_records',
        detail: `${location(principle)}：verified_count=${principle.verified_count}，无法按 I2 机器核对`,
        principle_id: principle.principle_id ?? null,
        project: principle.__project ?? null,
        file: principle.__file ?? null,
        field: 'verification_records',
      })
    }

    const months = monthsSince(principle.updated_at)
    if (months !== null) {
      const age = Math.round(months)
      if (months > 36 && actual === 'active') {
        add({
          severity: 'warning',
          code: 'stale',
          title: '长期未复核（仍为活跃）',
          detail: `${location(principle)}：updated_at=${principle.updated_at}，约 ${age} 个月前`,
          principle_id: principle.principle_id ?? null,
          project: principle.__project ?? null,
          file: principle.__file ?? null,
          field: 'updated_at',
        })
      } else if (months > 24) {
        add({
          severity: 'info',
          code: 'stale',
          title: '超过 24 个月未复核',
          detail: `${location(principle)}：updated_at=${principle.updated_at}，约 ${age} 个月前`,
          principle_id: principle.principle_id ?? null,
          project: principle.__project ?? null,
          file: principle.__file ?? null,
          field: 'updated_at',
        })
      }
    }
  }

  /* --- V1.5 维度映射 -------------------------------------------- */

  const aggregate = discovered.datasets.find((dataset) => dataset.source === 'v1-input')
  const projectDatasets = discovered.datasets.filter((dataset) => dataset.source === 'project')
  const fullLibrary = aggregate !== undefined || projectDatasets.length >= 3
  let coverage = null
  if (discovered.mapping === null) {
    add({
      severity: 'info',
      code: 'dimension-unmapped',
      title: '未找到 V1.5 维度映射',
      detail: '跳过维度覆盖检查；如需启用，把 principle-dimension-mapping.json 放在 V2 根目录',
    })
  } else {
    const mapping = discovered.mapping
    let unmapped = 0
    for (const principle of all) {
      const pid = String(principle.principle_id ?? '').trim()
      const project = String(principle.__project ?? '').trim()
      const entry = mapping.byKey.get(`${project}|${pid}`) ?? mapping.byName.get(normText(principle.name))
      if (entry === undefined) {
        unmapped += 1
        add({
          severity: 'info',
          code: 'dimension-unmapped',
          title: '未归一化到维度',
          detail: `${location(principle)}：V1.5 映射中没有对应条目`,
          principle_id: principle.principle_id ?? null,
          project: principle.__project ?? null,
          file: principle.__file ?? null,
        })
        continue
      }
      if (!Array.isArray(entry.dims) || entry.dims.length === 0) {
        add({
          severity: 'warning',
          code: 'dimension-unmapped',
          title: '映射条目 dims 为空',
          detail: `${location(principle)}：需要人工补标 12 维度`,
          principle_id: principle.principle_id ?? null,
          project: principle.__project ?? null,
        })
        continue
      }
      const mappedConfidence = Number(entry.confidence)
      const confidence = Number(principle.confidence)
      if (Number.isFinite(mappedConfidence) && Number.isFinite(confidence) && Math.abs(mappedConfidence - confidence) > 0.2) {
        add({
          severity: 'info',
          code: 'dimension-confidence',
          title: '映射置信度与原则置信度差异大',
          detail: `${location(principle)}：映射 ${mappedConfidence} vs 原则 ${confidence}`,
          principle_id: principle.principle_id ?? null,
          project: principle.__project ?? null,
        })
      }
    }

    if (fullLibrary) {
      const dimensionStats = []
      for (const dimension of mapping.dimensions ?? []) {
        const entries = mapping.principles.filter((entry) => Array.isArray(entry.dims) && entry.dims.includes(dimension.id))
        const projects = new Set(entries.map((entry) => String(entry.project ?? '').trim()).filter(Boolean))
        dimensionStats.push({
          id: dimension.id,
          name: dimension.name,
          count: entries.length,
          projects: projects.size,
        })
      }
      for (const stat of dimensionStats) {
        if (stat.count === 0) {
          add({
            severity: 'warning',
            code: 'dimension-coverage',
            title: `维度 ${stat.id} 没有原则`,
            detail: `${stat.name}：0 条，规则库无法覆盖该维度`,
          })
        } else if (stat.projects < 5) {
          add({
            severity: 'warning',
            code: 'dimension-coverage',
            title: `维度 ${stat.id} 支持集不足`,
            detail: `${stat.name}：${stat.count} 条 / ${stat.projects} 个项目，按 V4 规则应作观察项（权重归零）`,
          })
        }
      }
      coverage = {
        mappingFile: mapping.file,
        dimensions: dimensionStats,
        unmapped,
      }
    }
  }

  /* --- v0.4 封版 / 颠覆 / 账本 ------------------------------------ */

  const sealIndex = new Map()
  for (const principle of all) {
    if (principle?.seal?.seal_id) sealIndex.set(String(principle.seal.seal_id), principle)
  }
  const supersessions = all.filter((principle) => principle?.supersession !== undefined && principle.supersession !== null)

  if (sealIndex.size > 0 || supersessions.length > 0) {
    const ledgerFile = ledgerPath(discovered.root)
    let ledger = null
    if (existsSync(ledgerFile)) {
      const { events, errors } = readLedger(ledgerFile)
      for (const error of errors.slice(0, 3)) {
        add({
          severity: 'critical',
          code: 'ledger-chain-broken',
          title: `账本第 ${error.lineNo} 行无法解析`,
          detail: '账本行不是合法 JSON（I11）；拒绝采信其后的链证据',
        })
      }
      ledger = { events, chain: verifyChain(events) }
      for (const problem of ledger.chain.problems.slice(0, 5)) {
        add({
          severity: 'critical',
          code: 'ledger-chain-broken',
          title: `账本哈希链断裂（第 ${problem.lineNo} 行）`,
          detail: problem.reason,
        })
      }
    } else {
      add({
        severity: 'warning',
        code: 'ledger-chain-broken',
        title: '存在封版/颠覆记录但账本缺失',
        detail: `未找到 ${ledgerFile}（I11）：无法证明封版记录未被篡改`,
      })
    }

    for (const principle of all) {
      const seal = principle?.seal
      if (seal === undefined || seal === null) continue

      // seal-integrity：hash 合法性 + 与账本 seal 事件一致
      if (!isValidHash(seal.content_hash)) {
        add({
          severity: 'critical',
          code: 'seal-integrity',
          title: 'content_hash 格式非法',
          detail: `${location(principle)}：期望 sha256:<64 位十六进制>，实际 ${String(seal.content_hash).slice(0, 20)}…`,
          principle_id: principle.principle_id ?? null,
          project: principle.__project ?? null,
          field: 'seal.content_hash',
        })
      } else {
        const event = ledger?.chain.sealEvents.get(String(seal.seal_id))
        if (ledger !== null && event === undefined) {
          add({
            severity: 'warning',
            code: 'ledger-chain-broken',
            title: '封版记录无对应账本事件',
            detail: `${location(principle)}：${seal.seal_id} 在账本中无 seal 事件`,
            principle_id: principle.principle_id ?? null,
            project: principle.__project ?? null,
          })
        } else if (event !== undefined && event.content_hash !== seal.content_hash) {
          add({
            severity: 'critical',
            code: 'seal-integrity',
            title: '封版哈希与账本事件不一致（疑似伪造）',
            detail: `${location(principle)}：数据 ${String(seal.content_hash).slice(7, 19)}… vs 账本 ${String(event.content_hash ?? '').slice(7, 19)}…`,
            principle_id: principle.principle_id ?? null,
            project: principle.__project ?? null,
            field: 'seal.content_hash',
          })
        }
      }

      // silent-seal-edit：封版条目的规范字段被改动，或 version 漂移
      const recomputed = isValidHash(seal.content_hash) ? contentHash(principle) : null
      if (recomputed !== null && recomputed !== seal.content_hash) {
        add({
          severity: 'critical',
          code: 'silent-seal-edit',
          title: '封版后规范字段被修改（I8）',
          detail: `${location(principle)}：现算 ${recomputed.slice(7, 19)}… ≠ 封存 ${String(seal.content_hash).slice(7, 19)}…；要改只能升 version + supersession 继任`,
          principle_id: principle.principle_id ?? null,
          project: principle.__project ?? null,
          field: 'seal.content_hash',
        })
      }
      const sealVersion = String(seal.seal_id ?? '').match(/-v[0-9]+\.[0-9]+$/)?.[0]?.slice(1)
      if (sealVersion !== undefined && String(principle.version ?? '') !== sealVersion) {
        add({
          severity: 'critical',
          code: 'silent-seal-edit',
          title: '封版条目 version 已漂移（应新建继任条目）',
          detail: `${location(principle)}：seal 属于 ${sealVersion}，条目已是 ${principle.version}；封版条目必须保持只读`,
          principle_id: principle.principle_id ?? null,
          project: principle.__project ?? null,
          field: 'version',
        })
      }

      // seal-eligibility：判据仍满足 + 生命周期状态正确
      const lifecycle = String(principle.lifecycle_state ?? statusOf(principle.status, discovered.scoring) ?? '')
      if (lifecycle !== 'sealed' && lifecycle !== 'overturned' && lifecycle !== 'retired') {
        add({
          severity: 'warning',
          code: 'seal-eligibility',
          title: '有 seal 但 lifecycle_state 非 sealed/overturned/retired',
          detail: `${location(principle)}：当前 ${lifecycle || '未设置'}；封版条目应显式标记`,
          principle_id: principle.principle_id ?? null,
          project: principle.__project ?? null,
          field: 'lifecycle_state',
        })
      }
      const eligibility = sealEligibility(principle)
      if (!eligibility.ok) {
        add({
          severity: 'warning',
          code: 'seal-eligibility',
          title: '封版判据不再满足（I7）',
          detail: `${location(principle)}：${eligibility.missing.join('；')}`,
          principle_id: principle.principle_id ?? null,
          project: principle.__project ?? null,
        })
      }

      // seal-review-due：复核到期（封版不是免死金牌）
      const reviewTime = Date.parse(String(seal.next_review_at ?? ''))
      if (Number.isFinite(reviewTime) && Date.now() > reviewTime + 24 * 60 * 60 * 1000 && !seal.reaffirmed_at) {
        const months = Math.round((Date.now() - reviewTime) / (1000 * 60 * 60 * 24 * 30.44))
        add({
          severity: 'warning',
          code: 'seal-review-due',
          title: '封版复核已到期',
          detail: `${location(principle)}：next_review_at=${seal.next_review_at}，已过期约 ${months} 个月；须 reaffirm 或颠覆`,
          principle_id: principle.principle_id ?? null,
          project: principle.__project ?? null,
          field: 'seal.next_review_at',
        })
      } else if (Number.isFinite(reviewTime) && Date.now() > reviewTime + 24 * 60 * 60 * 1000 && seal.reaffirmed_at) {
        const reaffirmTime = Date.parse(String(seal.reaffirmed_at))
        if (Number.isFinite(reaffirmTime) && reaffirmTime < reviewTime) {
          add({
            severity: 'warning',
            code: 'seal-review-due',
            title: '封版复核已到期（reaffirm 早于本期）',
            detail: `${location(principle)}：reaffirmed_at=${seal.reaffirmed_at} 早于 next_review_at=${seal.next_review_at}`,
            principle_id: principle.principle_id ?? null,
            project: principle.__project ?? null,
          })
        }
      }

      // overturned 终态：必须有继任者或自带 retire 记录（I10）
      if (lifecycle === 'overturned' && !supersessions.some((item) => String(item.supersession?.supersedes ?? '') === String(seal.seal_id))) {
        add({
          severity: 'critical',
          code: 'overturn-incomplete',
          title: '已颠覆但无继任记录（I10）',
          detail: `${location(principle)}：${seal.seal_id} 没有任何 supersession 指向它，也无 mode=retire 记录`,
          principle_id: principle.principle_id ?? null,
          project: principle.__project ?? null,
        })
      }
    }

    for (const principle of supersessions) {
      const record = principle.supersession

      // overturn-incomplete：颠覆记录要素缺失（I9）
      const missing = []
      if (typeof record.supersedes !== 'string' || !/^SEAL-/.test(record.supersedes)) missing.push('supersedes')
      if (!['revise', 'split', 'retire'].includes(record.mode)) missing.push('mode')
      if (!['counter_example', 'violation', 'regime_change', 'm3_challenge', 'review_due'].includes(record.trigger)) missing.push('trigger')
      if (!Array.isArray(record.evidence_refs) || record.evidence_refs.length === 0) missing.push('evidence_refs')
      if (typeof record.diagnosis !== 'string' || record.diagnosis.trim() === '') missing.push('diagnosis')
      if (!record.decided_by?.id) missing.push('decided_by.id')
      if (typeof record.decided_at !== 'string' || record.decided_at.trim() === '') missing.push('decided_at')
      if (missing.length > 0) {
        add({
          severity: 'critical',
          code: 'overturn-incomplete',
          title: `颠覆记录缺要素：${missing.join('、')}（I9）`,
          detail: `${location(principle)}：颠覆必须留完整案卷（证据/根因/签核人/日期）`,
          principle_id: principle.principle_id ?? null,
          project: principle.__project ?? null,
          field: 'supersession',
        })
      }

      // seal-orphan：指向不存在的封版
      if (typeof record.supersedes === 'string' && /^SEAL-/.test(record.supersedes) && !sealIndex.has(record.supersedes)) {
        add({
          severity: 'critical',
          code: 'seal-orphan',
          title: 'supersedes 指向不存在的封版',
          detail: `${location(principle)}：${record.supersedes} 在库内无对应 seal 记录`,
          principle_id: principle.principle_id ?? null,
          project: principle.__project ?? null,
          field: 'supersession.supersedes',
        })
      }
    }
  }

  /* --- 汇总数据集与分项目的关系 --------------------------------- */

  if (aggregate !== undefined && projectDatasets.length > 0) {
    for (const principle of aggregate.principles) {
      const key = normText(principle.name)
      if (key === '') continue
      const matched = projectDatasets.find((dataset) => dataset.principles.some((item) => normText(item.name) === key))
      if (matched !== undefined) {
        add({
          severity: 'info',
          code: 'aggregate-overlap',
          title: '汇总数据集与分项目原则重复',
          detail: `「${principle.name}」也出现在 ${matched.project}；若汇总是独立项目，请忽略`,
          principle_id: principle.principle_id ?? null,
          file: aggregate.file,
        })
      }
    }
  }

  /* --- 汇总 ------------------------------------------------------ */

  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || a.code.localeCompare(b.code))

  /* --- 审查门禁：pass / warn / fail -------------------------------- */

  const exemptions = loadExemptions(discovered, options)
  const criticals = findings.filter((finding) => finding.severity === 'critical')
  const gate = {
    status: 'pass',
    criticals: criticals.length,
    exempted: 0,
    unexempted: 0,
    expired: [],
    exemptionsFile: exemptions?.file ?? null,
  }
  if (criticals.length > 0) {
    if (exemptions === null) {
      gate.status = 'fail'
      gate.unexempted = criticals.length
    } else {
      for (const finding of criticals) {
        const entry = exemptions.entries.find((candidate) => matchesExemption(finding, candidate) && !exemptionExpired(candidate))
        if (entry === undefined) {
          const stale = exemptions.entries.find((candidate) => matchesExemption(finding, candidate) && exemptionExpired(candidate))
          if (stale !== undefined) {
            const key = stale.principle_id ?? stale.code
            if (!gate.expired.includes(key)) gate.expired.push(key)
          }
          gate.unexempted += 1
          continue
        }
        gate.exempted += 1
        finding.exemption = { owner: entry.owner, reason: entry.reason, expires_at: entry.expires_at }
      }
      gate.status = gate.unexempted === 0 ? 'warn' : 'fail'
    }
  }

  const summary = {
    principles: all.length,
    datasets: discovered.datasets.length,
    projects: new Set(all.map((principle) => principle.__project).filter(Boolean)).size,
    dimensions: discovered.mapping?.dimensions?.length ?? 0,
    sealed: all.filter((principle) => principle?.seal?.seal_id).length,
    overturned: all.filter((principle) => String(principle.lifecycle_state ?? statusOf(principle.status, discovered.scoring) ?? '') === 'overturned').length,
    critical: findings.filter((finding) => finding.severity === 'critical').length,
    warning: findings.filter((finding) => finding.severity === 'warning').length,
    info: findings.filter((finding) => finding.severity === 'info').length,
    score: 0,
  }
  const penalty = (summary.critical * 10 + summary.warning * 3 + summary.info) / Math.max(1, summary.principles)
  summary.score = Math.max(0, Math.round(100 - penalty * 12))

  const datasets = discovered.datasets.map((dataset) => ({
    source: dataset.source,
    project: dataset.project ?? null,
    file: dataset.file,
    count: dataset.principles.length,
  }))

  const payload = {
    tool: 'principles_audit',
    version: VERSION,
    input: discovered.input,
    generatedAt: new Date().toISOString(),
    summary,
    gate,
    datasets,
    coverage,
    findings,
    reports: null,
  }

  const outputDir = typeof options.outputDir === 'string' && options.outputDir.trim() !== ''
    ? resolve(options.outputDir)
    : join(discovered.root, '.principles-audit')
  payload.reports = writeReports(payload, outputDir, discovered.root)
  return payload
}

/* ------------------------------------------------------------------ */
/* 报告                                                                */
/* ------------------------------------------------------------------ */

function timestamp() {
  const date = new Date()
  const pad = (value, size = 2) => String(value).padStart(size, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
}

function findingBullet(finding) {
  const where = [finding.project, finding.principle_id].filter(Boolean).join(' / ')
  const suffix = where.length > 0 ? `（${where}）` : ''
  const exempt = finding.exemption
    ? `\n  - 豁免：owner ${finding.exemption.owner || '—'} · 到期 ${finding.exemption.expires_at || '—'}${finding.exemption.reason ? ` · ${finding.exemption.reason}` : ''}`
    : ''
  return `- **[${finding.code}]** ${finding.title}${suffix}\n  - ${finding.detail}${finding.file ? `\n  - 文件：\`${finding.file}\`` : ''}${exempt}`
}

function renderMarkdown(payload) {
  const { summary, findings, coverage, datasets, input, generatedAt } = payload
  const lines = []
  lines.push('# 原则审查报告')
  lines.push('')
  lines.push(`> 输入：\`${input}\``)
  lines.push(`> 生成：${generatedAt}`)
  lines.push(`> 原则：**${summary.principles}** 条 · 数据集 **${summary.datasets}** 个 · 维度 **${summary.dimensions}** 个${summary.sealed > 0 || summary.overturned > 0 ? ` · 封版 **${summary.sealed ?? 0}** / 已颠覆 **${summary.overturned ?? 0}**` : ''}`)
  lines.push(`> 结果：**严重 ${summary.critical} / 警告 ${summary.warning} / 提示 ${summary.info}** · 健康分 **${summary.score}/100**`)
  if (payload.gate !== null && payload.gate !== undefined) {
    const g = payload.gate
    const expiredNote = g.expired.length > 0 ? `（已过期：${g.expired.join('、')}）` : ''
    lines.push(`> 审查门禁：**${GATE_LABEL[g.status] ?? g.status}（${g.status}）** — 严重 ${g.criticals} 项 = 豁免 ${g.exempted} + 未豁免 ${g.unexempted}${expiredNote}${g.exemptionsFile ? `；豁免表 \`${g.exemptionsFile}\`` : ''}`)
  }
  lines.push('')
  lines.push('## 数据集')
  lines.push('')
  lines.push('| 来源 | 项目 | 条数 | 文件 |')
  lines.push('| --- | --- | ---: | --- |')
  for (const dataset of datasets) {
    lines.push(`| ${dataset.source} | ${dataset.project ?? '—'} | ${dataset.count} | \`${dataset.file}\` |`)
  }
  lines.push('')

  for (const severity of ['critical', 'warning', 'info']) {
    const group = findings.filter((finding) => finding.severity === severity)
    if (group.length === 0) continue
    lines.push(`## ${SEVERITY_LABEL[severity]}（${group.length}）`)
    lines.push('')
    for (const finding of group) lines.push(findingBullet(finding))
    lines.push('')
  }

  if (coverage !== null) {
    lines.push('## 维度覆盖')
    lines.push('')
    lines.push('| 维度 | 名称 | 条数 | 项目数 | 判定 |')
    lines.push('| --- | --- | ---: | ---: | --- |')
    for (const dimension of coverage.dimensions) {
      const verdict = dimension.count === 0 ? '缺口' : dimension.projects < 5 ? '观察项（支持集<5）' : '可用'
      lines.push(`| ${dimension.id} | ${dimension.name} | ${dimension.count} | ${dimension.projects} | ${verdict} |`)
    }
    lines.push('')
    lines.push(`未归一化：**${coverage.unmapped}** 条（映射文件：\`${coverage.mappingFile}\`）`)
    lines.push('')
  }

  lines.push('## 说明')
  lines.push('')
  lines.push('- 本报告只读输入，不修改任何原则数据。')
  lines.push('- “严重/警告/提示”是启发式分级；每条都附 principle_id / 文件，便于人工复核。')
  lines.push('- 审查门禁口径：严重 0 → pass；严重项全部有效豁免 → warn（放行）；任一未豁免或豁免已过期 → fail（阻断）。')
  lines.push('- 未做 LLM 语义判断；如需“原则是否成立/是否可证伪”的语义审查，需另接模型。')
  lines.push('')
  return lines.join('\n')
}

function writeReports(payload, preferredDir, root) {
  const markdown = renderMarkdown(payload)
  const stamp = timestamp()
  const candidates = [
    preferredDir,
    join(homedir(), '.dsh', 'principles-audit'),
    join(root, '.principles-audit'),
  ]
  let lastError
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      const markdownPath = join(dir, `principles-audit-${stamp}.md`)
      const jsonPath = join(dir, `principles-audit-${stamp}.json`)
      writeFileSync(markdownPath, markdown, 'utf8')
      const finalPayload = { ...payload, reports: { markdownPath, jsonPath } }
      writeFileSync(jsonPath, JSON.stringify(finalPayload, null, 2), 'utf8')
      return { markdownPath, jsonPath }
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(`报告写入失败：${lastError?.message ?? lastError}`)
}

/* ------------------------------------------------------------------ */
/* 默认路径                                                             */
/* ------------------------------------------------------------------ */

export function defaultInput() {
  const override = process.env.DSH_PRINCIPLES_AUDIT_DIR
  if (typeof override === 'string' && override.trim() !== '') return override
  const candidate = process.env.DSH_PRINCIPLES_AUDIT_DIR || join(process.cwd(), 'principle-dashboard-v2')
  if (existsSync(candidate)) return candidate
  return undefined
}
