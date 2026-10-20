#!/usr/bin/env node
/**
 * dsh-principles-audit · 独立 CLI
 *
 * 用途：不装 DSH 插件也能对 V2 原则库跑一次审查，便于自测/CI/总线门禁。
 *
 * 用法：
 *   node cli.js --path <V2 根 / data / principles.json> [--output <dir>]
 *               [--exemptions <file>] [--checks a,b] [--json]
 *
 * 审查门禁（M2 结构一致性硬门禁）：
 *   严重 0 → pass；严重项全部有效豁免 → warn；任一未豁免/已过期 → fail。
 *   退出码：0 = pass/warn（放行），1 = fail（阻断），2 = 用法/输入错误。
 */
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { audit, defaultInput, VERSION } from './core/audit.js'

const ENGINE_ROOT = dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const options = { checks: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--path' || arg === '-p') {
      options.path = argv[i + 1]
      i += 1
    } else if (arg === '--output' || arg === '-o') {
      options.outputDir = argv[i + 1]
      i += 1
    } else if (arg === '--exemptions' || arg === '-e') {
      options.exemptionsPath = argv[i + 1]
      i += 1
    } else if (arg === '--checks' || arg === '-c') {
      options.checks = String(argv[i + 1] ?? '').split(',').map((item) => item.trim()).filter(Boolean)
      i += 1
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (!arg.startsWith('-')) {
      options.path = arg
    }
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(`dsh-principles-audit ${VERSION}

用法：
  node cli.js --path <V2 根 / data / principles.json> [--output <dir>] [--exemptions <file>] [--checks a,b] [--json]

默认路径：<principle-library>（可用 DSH_PRINCIPLES_AUDIT_DIR 覆盖）
审查门禁：严重 0 → pass；全部有效豁免 → warn（放行）；任一未豁免/过期 → fail（退出码 1）
检查项：id-collision / legacy-id / id-format / required-fields / boundary-missing /
        evidence-missing / duplicate-name / near-duplicate / status-confidence /
        stale / dimension-unmapped / dimension-coverage / dataset-empty / generation-notes /
        aggregate-overlap
封版项（v0.4）：seal-integrity / silent-seal-edit / overturn-incomplete / seal-orphan /
        seal-eligibility / seal-review-due / ledger-chain-broken（前四类+断链=critical→gate fail）
封版操作：node seal-cli.js --library <root> seal|overturn|reaffirm|verify --id <pid> …`)
    return 0
  }

  const path = options.path ?? defaultInput()
  if (!path) {
    console.error('缺少路径：请传 --path，或设置 DSH_PRINCIPLES_AUDIT_DIR')
    return 2
  }

  let result
  try {
    result = audit({ path, outputDir: options.outputDir, exemptionsPath: options.exemptionsPath, checks: options.checks, engineRoot: ENGINE_ROOT })
  } catch (error) {
    console.error(`审查失败：${error?.message ?? error}`)
    return 2
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    const { summary, gate, reports, findings } = result
    console.log(`原则审查完成：${result.input}`)
    console.log(`原则 ${summary.principles} 条 · 数据集 ${summary.datasets} 个 · 维度 ${summary.dimensions} 个`)
    console.log(`结果：严重 ${summary.critical} / 警告 ${summary.warning} / 提示 ${summary.info} · 健康分 ${summary.score}/100`)
    if (gate) {
      const label = { pass: '通过', warn: '带豁免放行', fail: '阻断' }[gate.status] ?? gate.status
      const expiredNote = gate.expired.length > 0 ? `（已过期：${gate.expired.join('、')}）` : ''
      console.log(`审查门禁：${label}（${gate.status}）— 严重 ${gate.criticals} = 豁免 ${gate.exempted} + 未豁免 ${gate.unexempted}${expiredNote}`)
    }
    const top = findings.slice(0, 12)
    if (top.length > 0) {
      console.log('')
      console.log('主要问题：')
      for (const finding of top) {
        const where = [finding.project, finding.principle_id].filter(Boolean).join(' / ')
        console.log(`- [${finding.severity}] ${finding.title}${where ? `（${where}）` : ''}`)
      }
      if (findings.length > top.length) console.log(`… 另有 ${findings.length - top.length} 条，见完整报告`)
    }
    console.log('')
    console.log(`完整报告：${reports.markdownPath}`)
    console.log(`JSON：${reports.jsonPath}`)
  }

  return result.gate?.status === 'fail' ? 1 : 0
}

process.exit(main())
