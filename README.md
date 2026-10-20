# dsh-principles-audit · 原则审查器

把「原则审查」做成 DSH 插件：agent 直接调用 **`principles_audit`** 工具，对 V2 原则库（`<principle-library>`）做一次结构化审查，输出 `critical / warning / info` 分级问题 + markdown/JSON 报告。

```
原则库 → principles_audit → 结构/一致性检查 → 分级 findings + 报告
```

只读输入，不修改任何原则数据。

## 一、操作路径（装完之后）

| 环节 | 实际组件 |
| --- | --- |
| 入口 | DSH agent 工具 `principles_audit`（插件 `index.js` 注册） |
| 用户/agent 动作 | `principles_audit({ path: "<principle-library>" })`，path 可省略 |
| 数据变化 | 在 `<V2根>/.principles-audit/` 写 `principles-audit-<时间戳>.md` 与 `.json`；**不改原则源文件** |
| 可观察结果 | 工具返回 `summary`（严重/警告/提示/健康分）+ 前 20 条 findings + 报告路径；报告可打开复核 |

## 二、默认输入路径

默认就是 V2 看板根目录：

```
<principle-library>
```

也可传：

- `.../principle-dashboard-v2/data`（只读 data 层）
- `.../data/v1-input/principles.json`（单个汇总文件）
- `.../data/projects/<项目B>/principles.json`（单个项目）
- 环境变量 `DSH_PRINCIPLES_AUDIT_DIR` 覆盖默认值

目录模式会自动发现：

- `data/v1-input/principles.json`（汇总）
- `data/projects/*/principles.json`（分项目）
- 同级或根目录下的 `principle-dimension-mapping.json`（V1.5 维度映射，可选）
- `config/scoring.json`（状态/置信度规则，可选）

## 三、检查项

| code | 级别 | 内容 |
| --- | --- | --- |
| `id-collision` | critical | 同一 `principle_id` 跨项目复用但名称不同（当前库 PR-001…PR-008 各 14 种含义） |
| `legacy-id` | info | 旧版项目内 ID（`PR-###`），提示迁移为全局 `PR-D##-####` |
| `id-format` | warning | ID 既不是 `PR-###` 也不是 `PR-D##-####` |
| `required-fields` | critical / warning / info | 缺 `principle_id` / `name` / `causal_statement`（critical），缺边界/反例/证据（warning），缺 `updated_at` / `version`（info） |
| `boundary-missing` | warning | `applicable_conditions` 或 `counter_examples` 为空（I5：不是原则，是口号） |
| `evidence-missing` | warning | `evidence[]` 为空，无法回溯 |
| `duplicate-name` | warning / info | 同名不同义（warning）或完全重复可合并（info） |
| `near-duplicate` | warning / info | 名称/因果句 2-gram Jaccard 相似度 ≥ 阈值（名称 0.85 / 因果句 0.8） |
| `status-confidence` | warning | 状态与 `scoring.json` 规则不一致；置信度越界 [0.2, 0.95]；违背 ≥3 仍为活跃 |
| `verification-records` | info | 有 `verified_count` 但没有 `verification_records`，无法按 I2 机器核对 |
| `stale` | warning / info | >36 个月仍活跃（warning）；>24 个月未复核（info） |
| `dimension-unmapped` | warning / info | V1.5 映射缺失、`dims` 为空、或汇总数据集未归一化 |
| `dimension-coverage` | warning | 维度 0 条；或支持集 <5 个项目（V4 规则：观察项，权重归零） |
| `dataset-empty` | critical | `principles[]` 为空 |
| `generation-notes` | info | 缺 `generation_notes` |
| `aggregate-overlap` | info | 汇总数据集与某个分项目原则同名 |

说明：

- **不做 LLM 语义判断**。它只审可机器复核的结构与一致性；「这条原则是否成立/是否可证伪」需要另接模型。
- 维度覆盖只在目录模式（能发现汇总 + 分项目）下检查；单文件模式只做单文件字段/ID 检查。
- 报告分级是启发式，每条都带 `principle_id` / 文件，便于人工复核。

## 四、调用方式

### 1. Agent 工具（装进 DSH 后）

```
principles_audit(
  path: ".../principle-dashboard-v2",   # 可省略，默认 V2 路径
  outputDir: "...",                     # 可省略，默认 <root>/.principles-audit
  checks: ["id-collision","stale"]      # 可省略，只跑部分检查
)
```

### 2. 独立 CLI（不装插件也能跑）

```bash
NODE="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
cd "<plugin-dir>/dsh-principles-audit"
"$NODE" cli.js --path "$HOME/<principle-library>" \
  --output ./test-output
```

也可以 `--json` 输出完整 JSON，或 `--checks stale` 只跑某一类。

## 五、安装（desktop profile）

```bash
CLI="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$CLI" plugin --profile desktop add \
  link:<plugin-dir>/dsh-principles-audit
```

然后确认 `~/.dsh/profiles/desktop/package.json`：

```json
{
  "dependencies": { "dsh-principles-audit": "link:/…/plugins/dsh-principles-audit" },
  "dsh": { "profile": { "bundles": [ "…", "dsh-principles-audit" ] } }
}
```

`bundles` 里没有这一行时插件不会加载。改完确认 GUI 工具列表里出现 `principles_audit`；没出现就重启一次 DSH。

卸载：`"$CLI" plugin --profile desktop remove dsh-principles-audit`（不删报告）。

## 六、本机实测（V2 当前数据）

**2026-10-19 新基线**（M2 会话已完成 112 条重构 + 项目内 ID 命名空间化，如 `<项目B>-PR-001`，104/104 全局唯一）：

```text
原则 112 条 · 数据集 14 个 · 维度 12 个
结果：严重 0 / 警告 41 / 提示 18 · 健康分 85/100
审查门禁：通过（pass）— 严重 0 = 豁免 0 + 未豁免 0
```

警告主体：`id-format`（命名空间 ID 尚未迁到全局 `PR-D##-####`，即「ID 迁移技术债」本身）、D05 支持集不足、部分原则长期未复核——均为质量问题，不阻塞结构验收。

历史基线（2026-10-17，重构前）：严重 8 / 警告 20 / 提示 17，健康分 83。8 条 severe 为裸 `PR-001…PR-008` 跨 14 数据集复用，**已由 M2 命名空间化重构消除**。

## 六.5、审查门禁（M2 结构一致性硬门禁）与豁免

**判定**（`gate.status`，CLI 退出码 0/1/2）：

| 条件 | 状态 | 行为 |
|---|---|---|
| 严重 0 | `pass` | 放行 |
| 严重项全部有**有效**豁免（owner + 未过期到期日） | `warn` | 放行，findings 打豁免标注 |
| 任一严重项未豁免 / 豁免已过期 | `fail` | 阻断（CLI exit 1） |

**豁免表** `exemptions/exemptions.json`（本插件自带，`applies_to: modules/m2_principles` 限定作用域）：

- 8 条 `id-collision`（裸 PR-001…008），owner `maintainer`，到期 **2026-11-30**，处置计划 = 下一版迁全局 `PR-D##-####`。
- 当前库严重项已清零，豁免表处于**休眠保护**状态：若裸 ID 回流（回滚/旧数据恢复），门禁自动降为 warn 至 2026-11-30，逾期回 fail。
- 发现顺序：`--exemptions` 参数 > `DSH_PRINCIPLES_AUDIT_EXEMPTIONS` > `<root>/.principles-audit/exemptions.json` > 插件自带。

**总线挂载**（2026-10-19）：管线在 M2 路由后、M4 组合前调结构门禁；fail 时 M2 状态置为 blocked、结果不进 M4（留底）、M4 决策改写为「阻塞：M2 结构门禁 fail」。门禁配置项为 `gate.m2_principles`。

## 六.6、封版（Seal）与颠覆（Supersession）· v0.4 P0

对标桥水的落点：**封的是"文本+证据的快照"，不是"信念"**——2011 版原文说原则是 evolving document、要持续 stress test，所以封版必带 `next_review_at`，被推翻只能继任、不能删改。设计全文见 `<internal-docs>/docs/principle-seal-and-supersession-v0.1.md`；schema 侧见 `principles.schema.json` v0.4（I7–I11 不变式、`seal`/`supersession` 字段、`sealed`/`overturned` 状态）。

**操作端**（先账本后 JSON，I11）：

```bash
NODE=…/node
"$NODE" seal-cli.js --library <V2根> eligible --id <pid>            # 查判据（I7：labels≥5/verified≥5/cross≥3/real_case≥1）
"$NODE" seal-cli.js --library <V2根> seal --id <pid> --actor <id> [--evidence a,b] [--review-years 1]
"$NODE" seal-cli.js --library <V2根> overturn --id <pid> --mode revise|retire \
        --trigger counter_example|violation|regime_change|m3_challenge|review_due \
        --evidence a,b --diagnosis "根因" --actor <id>              # revise=升版本继任；retire=无继任退休；split 手工
"$NODE" seal-cli.js --library <V2根> reaffirm --id <pid> --actor <id>
"$NODE" seal-cli.js --library <V2根> verify                          # 校验账本哈希链（断链 exit 1）
```

账本：`<V2根>/state/principle-ledger.jsonl`（追加式哈希链，`hash_self = sha256(hash_prev + 事件)`）。

**审计 7 项**（v0.4 新增，自动并入三态门禁）：

| check | 判据 | 级别 |
|---|---|---|
| `seal-integrity` | content_hash 格式非法；或与账本 seal 事件不一致（伪造） | critical |
| `silent-seal-edit` | 封版条目规范字段被改（现算哈希≠封存）；或 version 漂移 | critical |
| `overturn-incomplete` | 颠覆记录缺 evidence/diagnosis/decided_by/decided_at；或 overturned 无继任 | critical |
| `seal-orphan` | supersedes 指向不存在的 seal | critical |
| `ledger-chain-broken` | 账本断链/跳号/坏行（critical）；有封版但账本缺失（warning） | critical/warning |
| `seal-eligibility` | 标 sealed 但判据不满足；或 lifecycle 状态不对 | warning |
| `seal-review-due` | next_review_at 已过且未 reaffirm | warning |

兼容性：`id-collision` 改为按 `pid@version` 分组——同 ID 多版本是合法谱系（封版/继任），不再误报。测试：`node test/seal-test.mjs`（32 项断言全过：判据拒绝/合法封版/静默篡改/伪造哈希/缺要素颠覆/orphan/复核到期/账本篡改/版本谱系）。

## 六.7、P1 试点工具（VR 回填 / cross 回填）

```bash
# 验证记录回填（I2：verified/violated 由记录数自动重算，禁止手填）
node vr-cli.js --library <V2根> validate --file <records.csv|jsonl>   # 只校验
node vr-cli.js --library <V2根> import   --file <records.csv|jsonl>   # 回填（自动备份）
node vr-cli.js --library <V2根> status --id <pid>                     # 对账 + 距 verified≥5

# 跨场景同模式回填（I3：cross=去重项目数；只回填人工 confirmed=true 的候选）
node cross-cli.js --library <V2根> validate --confirm templates/p1-d07-cross-confirm.json
node cross-cli.js --library <V2根> apply --confirm templates/p1-d07-cross-confirm.json --dry-run
node cross-cli.js --library <V2根> apply --confirm templates/p1-d07-cross-confirm.json
```

模板：`templates/verification-records.csv`（记录列）、`templates/p1-d07-cross-confirm.json`（5 条 D07 候选的建议清单，默认全部 `confirmed:false`）。
运行手册（M2 执行用）：`<internal-docs>/docs/p1-d07-pilot-runbook.md`。
测试：`node test/p1-tools-test.mjs`（18 项断言：VR 校验/导入/I2/重复拒绝；cross 校验/dry-run/apply/I3）。

## 七、目录

```
plugins/dsh-principles-audit/
├── index.js              # host 插件：注册 principles_audit + 系统提示
├── cli.js                # 独立 CLI（自测/CI/总线门禁，退出码 0/1/2）
├── seal-cli.js           # 封版操作端（seal/overturn/reaffirm/verify，先账本后 JSON）
├── core/audit.js         # 审查引擎（纯 Node ESM，零依赖，含 gate 判定 + 封版 7 项检查）
├── core/seal.js          # 封版核心库（内容哈希/判据/记录构造/哈希链账本）
├── exemptions/
│   └── exemptions.json   # M2 门禁豁免表（8 条 id-collision，休眠保护）
├── test/
│   └── seal-test.mjs     # 封版/颠覆/账本 测试套件（32 项断言）
├── cordis.patch.yml      # 单行 host bundle patch
├── package.json
└── README.md
```

## 八、已知限制

- 只支持 V2 现有 JSON 结构（`principles[]`）；V1 v0.3 的新契约字段会按可选字段降级，不会因此报错。
- 相似度是字符 2-gram Jaccard，不是语义向量；同义改写不一定能抓到。
- 维度覆盖依赖 `principle-dimension-mapping.json`；没有映射时跳过并给 info。
- 报告写入优先 `<root>/.principles-audit`，失败时回退 `~/.dsh/principles-audit`。
- 门禁只认结构一致性（严重项）；「原则是否成立/反例是否真实」的质量审查由独立的质量审查流程（D1–D6）承担，两者互补。

## 九、来源

- 审查口径对齐 `principles.schema.json` 的 I1–I6 不变式与 `config/scoring.json` 的状态规则。
- 维度口径对齐 `principle-dimension-mapping.json`（V1.5 维度映射）与「支持集<5 → 观察项」规则。
- 插件结构参照同目录 `dsh-office-audit`（host-only、零运行时依赖）。
