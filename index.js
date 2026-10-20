/**
 * Host half of dsh-principles-audit.
 *
 * Registers one agent tool, `principles_audit`, plus a short system-prompt
 * section. The audit engine is pure Node ESM (`core/audit.js`) with zero
 * runtime dependencies: it reads the principle library, produces
 * critical/warning/info findings and writes markdown + JSON reports.
 *
 * @module dsh-principles-audit
 */
import { isAbsolute, resolve } from 'node:path'
import { audit, defaultInput } from './core/audit.js'

/** Cordis plugin name. */
export const name = 'dsh-principles-audit'

/** Required host services: tool registry + prompt assembly. */
export const inject = ['tools', 'systemPrompt']

/* ------------------------------------------------------------------ */
/* defineTool (structure-compatible reimplementation of the SDK's)     */
/* ------------------------------------------------------------------ */

function compileValue(spec) {
  const node = {}
  if (typeof spec.description === 'string' && spec.description.length > 0) node.description = spec.description
  const type = spec.type
  if (type === undefined || type === 'json') return node
  if (type === 'object') {
    node.type = 'object'
    node.additionalProperties = spec.additionalProperties
    if (spec.properties !== undefined) node.properties = compilePropertyMap(spec.properties).properties
    return node
  }
  if (type === 'array') {
    node.type = 'array'
    if (spec.items !== undefined) node.items = compileValue(spec.items)
    return node
  }
  node.type = type
  if (spec.enum !== undefined) node.enum = [...spec.enum]
  if (spec.const !== undefined) node.const = spec.const
  return node
}

function compilePropertyMap(spec) {
  const properties = {}
  const required = []
  for (const [key, entry] of Object.entries(spec)) {
    const { required: isRequired, ...valueSpec } = entry
    properties[key] = compileValue(valueSpec)
    if (isRequired === true) required.push(key)
  }
  return required.length > 0 ? { properties, required } : { properties }
}

function matchesScalarType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number'
    case 'integer': return typeof value === 'number' && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

function validateValue(schema, value, path) {
  if (typeof schema.type !== 'string' || schema.type.length === 0) return []
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path} must be an object`]
    const violations = []
    for (const key of schema.required ?? []) if (!(key in value)) violations.push(`${path}.${key} is required`)
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(value)) if (!known.has(key)) violations.push(`${path}.${key} is not a declared property`)
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) violations.push(...validateValue(child, value[key], `${path}.${key}`))
    }
    return violations
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`]
    const violations = []
    if (schema.items !== undefined) value.forEach((item, i) => violations.push(...validateValue(schema.items, item, `${path}[${i}]`)))
    return violations
  }
  if (!matchesScalarType(value, schema.type)) return [`${path} must be ${schema.type}`]
  if (schema.enum !== undefined && !schema.enum.some((item) => item === value)) return [`${path} must be one of ${schema.enum.map(String).join(', ')}`]
  if (schema.const !== undefined && schema.const !== value) return [`${path} must be ${String(schema.const)}`]
  return []
}

function defineTool(options) {
  const compiled = compilePropertyMap(options.parameters)
  const parameters = { type: 'object', properties: compiled.properties }
  if (compiled.required !== undefined) parameters.required = compiled.required
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: {},
      render(args, value) {
        return options.output.render(args, value)
      },
    },
    async execute(args, exec) {
      const violations = validateValue(parameters, args, 'arguments')
      if (violations.length > 0) throw new Error(`Error: invalid arguments: ${violations.join('; ')}`)
      return options.execute(args, exec)
    },
  }
}

/* ------------------------------------------------------------------ */
/* 路径与渲染                                                           */
/* ------------------------------------------------------------------ */

function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

function resolveInput(args, exec) {
  const raw = typeof args.path === 'string' && args.path.trim().length > 0 ? args.path.trim() : defaultInput()
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('Error: invalid_input: path is required (default V2 path not found; set DSH_PRINCIPLES_AUDIT_DIR)')
  }
  return isAbsolute(raw) ? raw : resolve(sessionCwd(exec), raw)
}

const SEVERITY_LABEL = { critical: '严重', warning: '警告', info: '提示' }

function renderAudit(_args, value) {
  if (value === null || typeof value !== 'object') return [{ type: 'text', text: String(value) }]
  if (value.error !== undefined) return [{ type: 'text', text: `原则审查失败：${value.error}` }]

  const summary = value.summary ?? {}
  const gate = value.gate
  const findings = Array.isArray(value.findings) ? value.findings : []
  const lines = []
  lines.push(`原则审查完成：${value.input ?? ''}`)
  lines.push(`原则 ${summary.principles ?? 0} 条 · 数据集 ${summary.datasets ?? 0} 个 · 维度 ${summary.dimensions ?? 0} 个`)
  lines.push(`结果：严重 ${summary.critical ?? 0} / 警告 ${summary.warning ?? 0} / 提示 ${summary.info ?? 0} · 健康分 ${summary.score ?? 0}/100`)
  if (gate !== null && gate !== undefined) {
    const label = { pass: '通过', warn: '带豁免放行', fail: '阻断' }[gate.status] ?? gate.status
    const expiredNote = gate.expired?.length > 0 ? `（已过期：${gate.expired.join('、')}）` : ''
    lines.push(`审查门禁：${label}（${gate.status}）— 严重 ${gate.criticals} = 豁免 ${gate.exempted} + 未豁免 ${gate.unexempted}${expiredNote}`)
  }

  const top = findings.slice(0, 20)
  if (top.length > 0) {
    lines.push('', '主要问题：')
    for (const finding of top) {
      const where = [finding.project, finding.principle_id].filter(Boolean).join(' / ')
      lines.push(`- [${SEVERITY_LABEL[finding.severity] ?? finding.severity}] ${finding.title}${where.length > 0 ? `（${where}）` : ''}`)
    }
    if (findings.length > top.length) lines.push(`… 另有 ${findings.length - top.length} 条，见完整报告`)
  } else {
    lines.push('', '未发现需要报告的问题。')
  }

  if (value.reports?.markdownPath) lines.push('', `完整报告：${value.reports.markdownPath}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/* ------------------------------------------------------------------ */
/* plugin apply                                                        */
/* ------------------------------------------------------------------ */

const PROMPT_SECTION = `## 原则审查器（principles_audit）

当用户要求审查/审计原则库、M2 原则内容、V2 原则看板数据，或你即将交付一批原则时，先调用 principles_audit，再向用户汇报。

- 参数 path：V2 根目录（如 <principle-library>）、data/ 目录，或单个 principles.json；省略时用默认 V2 路径。
- 检查：principle_id 冲突/复用、旧版 ID、字段完整性（因果句/适用边界/反例/证据）、同名不同义、近重复、状态与置信度不一致、长期未复核、V1.5 维度覆盖、汇总与分项目关系。
- 审查门禁：严重 0 → pass；严重项全部有效豁免（owner+到期日未过期）→ warn 放行；任一未豁免/已过期 → fail 阻断。豁免表可用 exemptionsPath 指定，默认自动发现（<root>/.principles-audit/exemptions.json 或插件自带）。
- 输出 critical / warning / info 分级 findings + gate 三态结果，附 markdown + JSON 报告路径；只读输入，不修改原则数据。
- 语义判断（原则是否成立/是否可证伪）不在本工具范围内；它只做可复核的结构与一致性审查。`

export function apply(ctx) {
  const disposers = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'principles_audit',
    description: 'Audit a principle library (V2 dashboard data): detect principle_id collisions/legacy IDs, missing causal statements/boundaries/counter-examples/evidence, duplicate and near-duplicate principles, status-vs-confidence inconsistencies, stale principles, V1.5 dimension coverage gaps, and aggregate-vs-project mismatches. Also evaluates a hard gate (pass/warn/fail): critical=0 → pass; all criticals covered by valid, unexpired exemptions → warn; otherwise fail. Returns severity-ranked findings, gate status, and markdown/JSON report paths. Read-only.',
    parameters: {
      path: {
        type: 'string',
        description: 'V2 root directory, data/ directory, or a principles.json file. Defaults to $DSH_PRINCIPLES_AUDIT_DIR or the current working directory.',
      },
      outputDir: {
        type: 'string',
        description: 'Directory for the report files (default: <root>/.principles-audit).',
      },
      exemptionsPath: {
        type: 'string',
        description: 'Exemptions file for the hard gate (JSON with exemptions[]: code/principle_id/owner/reason/expires_at). Auto-discovered when omitted.',
      },
      checks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional category ids to restrict the audit, e.g. ["id-collision","stale"]. Empty = all.',
      },
    },
    output: { render: renderAudit },
    async execute(args, exec) {
      try {
        const input = resolveInput(args, exec)
        const outputDir = typeof args.outputDir === 'string' && args.outputDir.trim().length > 0
          ? resolve(sessionCwd(exec), args.outputDir)
          : undefined
        const exemptionsPath = typeof args.exemptionsPath === 'string' && args.exemptionsPath.trim().length > 0
          ? resolve(sessionCwd(exec), args.exemptionsPath)
          : undefined
        return audit({
          path: input,
          outputDir,
          exemptionsPath,
          checks: Array.isArray(args.checks) ? args.checks : [],
          engineRoot: HERE,
        })
      } catch (error) {
        return { error: String(error?.message ?? error) }
      }
    },
  })))

  const disposeSection = ctx.systemPrompt.section({
    name: 'principles-audit',
    order: 186,
    text: PROMPT_SECTION,
  })
  ctx.effect(() => disposeSection, 'dsh-principles-audit: prompt section')

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'dsh-principles-audit: tools')
}
