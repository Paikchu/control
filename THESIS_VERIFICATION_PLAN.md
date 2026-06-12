# SEC 业绩提取 + 持仓逻辑 AI 验证 — 实现方案报告

> 目标：用 DeepSeek 把每份 SEC filing 的关键业绩表格抽成结构化 RAG 数据落库；用户为每条持仓逻辑（thesis）拿到 AI 验证结论——逻辑是否成立、是否发生改变，并附可溯源证据。

## 1. 范围确认（已决策）

- **覆盖表单**：
  - **业绩/事件类**：10-K / 10-Q / 8-K **及其修正案**（10-K/A、10-Q/A、8-K/A）——回溯最近 **8 份**。
  - **内部人交易类**：**Form 4（含 3 / 5 / 4-A）**——“卖股”既可能是公司层面增发回购（8-K），也可能是内部人减持（Form 4），**两种都纳入，由 DeepSeek 读内容自行判断归类，代码不写死规则**。Form 4 申报极频繁，**单列一条轨道**、独立深度上限，不挤占 8 份业绩 filing 名额（建议近 12 个月且上限 ~20 份）。
- **回溯深度**：业绩/事件类每票 **8 份**；内部人交易类独立窗口（见上）。
- **触发模型**：DeepSeek（`DEEPSEEK_SEC_MODEL`，默认 `deepseek-v4-pro`），沿用现有 `api.deepseek.com/chat/completions` + JSON mode。
- **存储**：复用本地 `data/market-cache.sqlite`（`node:sqlite` / `DatabaseSync`）。
- **持仓逻辑数据源**：thesis 目前只存前端 `localStorage`（`portfolio-backtest:holdings:v1` 的 `thesisItems`），服务端无副本——验证接口需由前端把 thesis 文本随请求 POST 上来。

## 2. 现状盘点

| 能力 | 现状 | 缺口 |
|---|---|---|
| filing 列表 / CIK 解析 | `getSecFilings` / `getSecCompany` 已具备 | `secForms` 用精确匹配，`10-K/A`、`10-Q/A` 被排除 |
| filing 全文抓取 | `getFilingRaw` / `getFilingText`（HTML→纯文本） | 纯文本化会丢表格结构；只抓 `primaryDocument`，**8-K 的财务数据大多在附件 EX-99.1，不在主文档** |
| 结构化财务指标 | `extractInlineFinancialMetrics`（inline XBRL，仅 5 个利润表科目）；落 `sec_report_facts` | 无分部收入 / 经营 KPI / 指引 / 事件；只对“最新一份” filing 跑 |
| DeepSeek 调用 | `analyzeFilingSummaryWithDeepSeek`（中文摘要）、`analyzeFilingSectionsWithDeepSeek`（信号） | 无“关键表格→结构化 JSON”提取 prompt |
| 章节切分 | `splitFilingSections`（按行关键词，粗） | 不区分 `<table>` 区块 |
| filing 级缓存 | `sec_filing_summaries` 按 `(ticker, accession)` 幂等 | 无 extracts / chunks / thesis-check 表 |
| SEC 抓取限流 | `secFetch` **无任何限流**（裸 fetch + UA） | 批量抓 8 份×多票 + 附件易触发 SEC 10 req/s 限制 |

## 3. 总体架构（三层）

```
filing 原文 (HTML + 附件)
   │  ① 提取管线 (DeepSeek, 按 accession 幂等)
   ▼
sec_filing_extracts (结构化: segment/kpi/guidance/event/financial)
sec_filing_chunks   (FTS5 文本块, 供原文取证)
   │  ② 检索 (结构化全量 + 关键词取证)
   ▼
thesis-check API (DeepSeek 逐条验证)
   │  ③ 缓存 (ticker, thesis_hash, latest_accession)
   ▼
前端持仓页: 每条 thesis 的 verdict 徽标 + 分析 + 证据引用
```

## 4. 数据模型（追加到 server.mjs 建表块）

```sql
-- 结构化提取结果（filing 维度，永久幂等）
CREATE TABLE IF NOT EXISTS sec_filing_extracts (
  ticker            TEXT NOT NULL,
  accession_number  TEXT NOT NULL,
  form              TEXT,
  filing_date       TEXT,
  report_date       TEXT,
  kind              TEXT NOT NULL,   -- financial | segment | kpi | guidance | event
  label             TEXT NOT NULL,   -- 指标/事件名, e.g. "Service revenue - North America"
  period            TEXT,            -- "2025 Q2" / 区间 / 事件日期; 无周期填 ''
  value             REAL,            -- 数值, 非数值类填 NULL
  unit              TEXT,            -- USD / shares / % / subscribers ...
  detail            TEXT,            -- 中文说明
  quote             TEXT,            -- 原文引用 (溯源)
  importance        TEXT,            -- high | medium | low
  generated_at      TEXT NOT NULL,
  PRIMARY KEY (ticker, accession_number, kind, label, period)
);
CREATE INDEX IF NOT EXISTS idx_extracts_ticker ON sec_filing_extracts(ticker, kind);

-- 文本块（FTS5, 取证用; node v25 内置 sqlite 已验证支持 FTS5）
CREATE VIRTUAL TABLE IF NOT EXISTS sec_filing_chunks USING fts5(
  ticker, accession_number, form, filing_date, section, chunk_text
);

-- filing 是否已提取 (幂等哨兵, 避免重复调 DeepSeek 和并发重入)
CREATE TABLE IF NOT EXISTS sec_filing_extract_status (
  ticker            TEXT NOT NULL,
  accession_number  TEXT NOT NULL,
  status            TEXT NOT NULL,   -- pending | done | skipped | error
  reason            TEXT,
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (ticker, accession_number)
);

-- 持仓逻辑验证结果缓存 (新 filing 到达自动失效)
CREATE TABLE IF NOT EXISTS holding_thesis_checks (
  ticker                   TEXT NOT NULL,
  thesis_hash              TEXT NOT NULL,   -- hash(规范化 thesis 文本)
  latest_accession_number  TEXT NOT NULL,   -- 参与验证的最新 filing
  thesis_text              TEXT,
  payload                  TEXT NOT NULL,   -- 验证结果 JSON
  generated_at             TEXT NOT NULL,
  PRIMARY KEY (ticker, thesis_hash, latest_accession_number)
);
```

> **不引入向量库**：DeepSeek 无 embeddings 端点；单票 8 份 filing 的结构化 extracts 仅几 KB，可整体进 prompt。语义检索留作后续可加 embedding 列，表结构不变。

## 5. 提取管线设计

**触发**：决策为 **添加持仓时后台预提取**。前端新增/编辑持仓 → `POST /api/holdings/:ticker/prefetch` → 服务端后台对该票最近 8 份业绩 filing + 内部人交易窗口异步排队提取（不阻塞响应），thesis-check 时大概率已就绪。

**入口**：`ensureFilingExtracted(ticker, filing)`，按 `sec_filing_extract_status` 幂等；`getSecFilings` 返回后对前 8 份未提取的异步排队。

**两类文档分流**：
- **HTML filing（10-K/10-Q/8-K 及 /A）**：走下面的正文+附件+表格步骤。
- **Form 4/3/5（XML `ownershipDocument`）**：是结构化 XML，不是叙述文本，**单独解析器**——抽 `nonDerivativeTransaction` / `derivativeTransaction` 的人、角色、交易码（S/P/A/F/M/G…）、股数、价格、交易后持股、`10b5-1` 计划标记，落 `kind='event'`（`label` 形如 `Insider sale - <人名>`）。交易码语义与“是减持还是激励行权”交给 DeepSeek 判断，不在代码里写死映射。

**每份 HTML filing 步骤**：
1. **取正文 + 附件**：10-K/10-Q 用 `primaryDocument`；**8-K 额外解析 index（`filingIndexUrl`）取 EX-99.x 附件**，业绩表格与卖股/增发披露通常在附件而非主文档。
2. **抽 `<table>` 区块**：从原始 HTML 正则切出 `<table>…</table>`，连同上文标题一起单独喂 DeepSeek（纯文本化会破坏表格——这是当前链路对“关键业绩表格”的最大短板）。
3. **DeepSeek 表格提取**（新 JSON 模式 prompt）：输出固定 schema —
   - `financial`：营收/毛利/经营利润/净利/OCF/capex（补 XBRL 缺口）
   - `segment`：分部 / 产品线 / 地区收入拆分（XBRL 难拿、对验证最有价值）
   - `kpi`：用户数、订阅、产能、backlog、合同额等非 GAAP
   - `guidance`：管理层指引（指标 + 区间 + 期间）
   - `event`：融资、增发 / 卖股、回购、摊薄、诉讼、客户集中度、高管变动；每条带 quote
4. **归一化落 `sec_filing_extracts`**；同时把章节文本切 ~1500 字块写 `sec_filing_chunks`；状态置 `done`。
5. **XBRL 交叉校验**：`financial` 数值与 `extractInlineFinancialMetrics` 同期对比，偏差 >5% 标记 `low` 置信并保留两者。

**8-K 过滤**：8-K 仍全部纳入提取，但无财务表/无可提取事件的（如纯高管离职封面页）状态置 `skipped`，避免空调用浪费。

## 6. 检索方案（验证时）

1. **结构化**：取该 ticker 全部 `sec_filing_extracts`（≤8 份，体积小）整体入 prompt。
2. **原文取证（两步，规避中英文不匹配）**：thesis 多为中文，filing 为英文，FTS5 直接按中文词匹配不到——先让 DeepSeek 从每条 thesis 抽 **英文关键词 + 关注指标**，再用关键词查 `sec_filing_chunks`（FTS5 `MATCH`）取 top-N 块作为证据。

## 7. 验证功能设计（自洽性 + 时效性合一）

把两件事收敛成**一次 Agent 检验**，共用同一套 RAG 数据：
- **自洽性**（用户本轮诉求）：Agent 把一条逻辑拆成「前提 → 结论」，自主决定检索什么，判断 ① 前提是否属实、② 前提能否推出结论、③ 多条逻辑/与风险点是否互相冲突。
- **时效性**（上版 verdict）：用最新 filing 看现在还成不成立、变没变。

**API**：`POST /api/holdings/:ticker/thesis-check`
- body：`{ thesisItems: [{ id, text }], riskItems: [{ id, text }], force?: bool }`（riskItems 一并传入以做条间矛盾检测）
- 流程：确保 8 份 filing 已提取 → 命中 `holding_thesis_checks` 缓存（key 含 latest accession，无新 filing 直接返回）→ 否则调 DeepSeek（Agent 式：先抽英文关键词→检索→逐条判断）→ 落缓存。

**返回 schema**：
```json
{
  "items": [{
    "thesisId": "thesis-1",
    "verdict": "supported | weakened | broken | no_evidence",
    "consistency": "consistent | self_contradictory | premise_false",
    "confidence": 0.0,
    "premises": [                              // 论据拆解（自洽性核心）
      { "claim": "前提原文/转述", "holds": true,
        "note": "10-Q 证实 …", "evidenceRef": 0 }
    ],
    "analysis": "中文：逻辑当前是否成立",
    "changes": "相对该逻辑预期，最新 filing 出现的变化",
    "retrieval": { "keywords": ["BlueBird satellite"], "hitFilings": ["0001-25-000123"] },
    "evidence": [{ "accessionNumber": "...", "period": "...", "metric": "...", "quote": "..." }]
  }],
  "crossItemConflicts": [                       // 组合自洽性
    { "between": ["thesis-2", "risk-1"], "detail": "两者都指向摊薄问题" }
  ],
  "coverage": { "filingsUsed": 6, "filingsExpected": 8 }
}
```

**Prompt 约束**（沿用现有 summary 风格）：只用给定证据；数字必须可溯源到 quote；前提无证据判 `no_evidence`，禁止编造；矛盾要点出具体冲突；**输出信号而非买卖建议**（防止 `broken` 误判诱导用户割肉）。

**缓存失效**：主键 `(ticker, thesis_hash, latest_accession)` —— thesis 改写 → hash 变；新 filing → accession 变；二者任一变化自动重算，天然实现“检查持仓逻辑是否改变”。`thesis_hash` 对 thesisItems + riskItems 一起取，改风险点也会触发条间矛盾重算。

## 8. 前端融合设计（src/main.jsx 持仓逻辑 tab）

**原则**：不动现有内联编辑器（`holdingThesisWorkspace` 的 thesisItems / riskItems 列表写起来快），AI 能力作为**叠加层**，默认不打扰、按需触发。融合落点对应现有 DOM：

**① Section 头部加 AI 工具栏**（现 `holdingEditorHead` 那行）
- 右侧加：自洽/存疑统计 chip（如 `2 自洽 · 1 存疑`）+ 「上次检验」时间 + 主按钮 **「AI 检验逻辑」**（一次性检验全部条目，`force` 可重检）。

**② 每条 `holdingReminderRow` 右侧加状态徽标**（input 与删除按钮之间）
- 四态：`自洽·有据`(success) / `不自洽`(warning) / `检验中`(info) / `filing 中无证据`(neutral)；整行用边框色区分，扫一眼定位问题条。
- 徽标合并表达 verdict 与 consistency 两维：`broken`/`premise_false`/`self_contradictory` → 红/琥珀，`supported && consistent` → 绿，`no_evidence` → 灰。

**③ 每条可展开分析抽屉**（Agent 检索 + 自洽性的落点，三块）
- **论据拆解**：渲染 `premises[]`，每条前提 ✓/✗ + note（自洽性可视化）。
- **Agent 检索轨迹**：渲染 `retrieval.keywords` / `hitFilings`，让“检索能力”可见、可信。
- **证据 + 动作**：`evidence[].quote` 可点跳 filing PDF（`/api/sec/filings/:ticker/:accession.pdf`）；不自洽时给「改写这条逻辑」按钮。

**④ 底部「组合自洽性」callout**（whole-thesis）
- 渲染 `crossItemConflicts[]` + `coverage`，回答“整套逻辑是否打架 / 证据覆盖多少”——单条检验给不了的全局视角。

**“自洽性”在 UI 上的三层**：条内自洽（前提能否推出结论）｜与事实自洽（前提是否被 SEC 数据证实）｜条间自洽（逻辑之间、逻辑与风险点是否冲突）。

**状态与缓存**：
- 首次提取（prefetch）进行中显示 pending；检验中显示逐条 `检验中`。
- thesis-check 结果缓存到 localStorage（`portfolio-backtest:holdings:v1` 旁加 `thesisChecks`），按 thesis_hash 命中，避免重复请求；徽标措辞克制，**给信号不给买卖建议**。

> 界面草图见本次会话渲染的融合 mockup（ASTS 示例）。

## 9. 异常与边界问题清单（重点）

### A. 8-K / 文档结构
1. **8-K 数据在附件不在主文档**：必须解析 index 抓 EX-99.x，否则提取为空。
2. **Form 4 是 XML，不是 HTML 叙述**：需独立 `ownershipDocument` 解析器；衍生/非衍生两张表；交易后持股、`10b5-1` 计划标记需保留（计划性减持的看空含义弱于自主减持，交给 AI 区分）。
3. **Form 4 申报量大**：单票可能几十上百份，会瞬间挤爆 8 份名额 → 单列轨道 + 独立窗口/上限（近 12 月、≤20 份），并与业绩 filing 分开抓取队列。
4. **`secForms` 精确匹配需改造**：现 `Set(['10-K','10-Q','8-K'])` 精确匹配，排除了 /A 修正案与 Form 4 → 改为谓词：基础表单 ∈ {10-K,10-Q,8-K}（含 /A）或 ∈ {3,4,5}（含 /A）。
5. **表格结构丢失**：HTML filing 必须单独喂 `<table>`，不能只用纯文本。
6. **老 filing 无 inline XBRL / 8-K 附件无 XBRL 标签**：结构化校验只能靠 DeepSeek 读表，无法交叉核对，需降低置信标记。

### B. 数据正确性
7. **数量级 / 单位错误**：表头 “in thousands/millions”、括号负数、脚注标记——prompt 强制识别 `unit` 与缩放；与 XBRL 交叉校验兜底。
8. **财报重述（restatement）**：同一 period 在不同 filing 值不同。现有 `sec_report_facts` 主键 `(ticker, period, metric)` 会被覆盖；新表 `sec_filing_extracts` 主键含 `accession_number`，按 filing 保留，避免丢历史口径。
9. **修正案口径覆盖**：10-K/A、10-Q/A 修正原报告数据；按 filing 分键保留，验证时以 `filing_date` 最新者为准，并保留“被修正”痕迹。
10. **非自然年财年 / 季度判定**：沿用 `quarterFromEndDate`，但分部数据周期需让 DeepSeek 明确回报 period，避免错配。
11. **DeepSeek 数字幻觉**：强制 quote 溯源 + 数值交叉校验 + 无证据留空。

### C. LLM / 调用层
12. **JSON 截断 / 解析失败**：大表可能超输出长度。需健壮解析 + 单次重试 + 失败落 `error` 状态（不阻塞其他 filing）。
13. **上下文超限**：10-K 极大，不能整篇喂；只送 `<table>` 区块 + 目标章节。
14. **成本 / 速率（DeepSeek 429）**：靠 `extract_status` 幂等，每份只提取一次；并发加退避重试。Form 4 量大，需批量合并提取（多份 Form 4 一次调用）降本。
15. **非确定性**：temp 0.1 仍非完全确定；按内容 hash 缓存，避免重复抖动。

### D. SEC 抓取
16. **`secFetch` 无限流**：批量抓 8 份×多票 + 附件 + Form 4 窗口易撞 SEC 10 req/s。→ 加全局串行队列 + 最小间隔（~150ms）/ 退避；提取走后台异步而非阻塞首个 thesis-check。
17. **并发重入**：同一 filing 被多次触发提取。→ `extract_status=pending` 作 in-flight 锁 + 内存级 dedupe。
18. **ticker 无 CIK / 退市 / 改名**：优雅报错，thesis-check 返回 `no_evidence` 而非 500。

### E. 验证语义
19. **中文 thesis vs 英文 filing**：FTS5 关键词不跨语言匹配 → DeepSeek 先抽英文关键词再检索（见 §6）。
20. **thesis 不可证伪**（“看好前景”）：判 `no_evidence`，提示用户写成可量化命题。
21. **趋势型 thesis**（“毛利率持续改善”）：需多期对比，验证时喂多季 `financial` 序列而非单份。
22. **内部人交易解读**：减持不必然看空（10b5-1 计划、行权缴税、捐赠）；让 AI 结合交易码/footnote 给方向，UI 不替用户下定论。
23. **证据矛盾 / 过度自信**：`broken` 需高门槛 + 必附证据；UI 措辞为“信号”，避免诱导交易决策。
24. **部分提取完成**：8 份里只成功几份时，验证需声明证据覆盖范围（已用 N/8 份）。

### F. 存储 / 运维
25. **thesis 文本落服务端**（缓存需要）：本地单机应用可接受；如需隐私可只存 hash + 由前端持有明文。
26. **FTS5 可用性**：已在 node v25 验证支持；仍需在启动建表时 try/catch，缺失则降级为普通表 + JS 关键词过滤。
27. **磁盘增长**：chunks + extracts + Form 4 随票数增长，可接受；可加按 ticker 清理。
28. **DB 迁移**：全部 `CREATE TABLE IF NOT EXISTS`，与现有建表块并列，无破坏性变更。

## 10. 实施步骤

1. 建表（4 张）+ `extract_status` 幂等骨架 + SEC 抓取串行限流队列。
2. 8-K 附件解析 + `<table>` 抽取 + DeepSeek 表格提取 prompt + 归一化落库；单测覆盖 schema 归一化与单位/数量级。
3. `sec_filing_chunks` 写入 + FTS5 检索函数（含降级）+ 单测。
4. `POST /api/holdings/:ticker/thesis-check`（自洽性 premises + 时效性 verdict + crossItemConflicts）+ 缓存失效 + 关键词两步检索。
5. 前端融合（§8）：AI 工具栏 + 逐条徽标 + 论据拆解/检索轨迹/证据抽屉 + 组合自洽性 callout。
6. 端到端：用现有持仓（ASTS / SATS / QQQ）跑真实 filing，人工核对 verdict 与 quote 可溯源。

## 11. 验证计划

- `node --test test/*.test.mjs`：新增提取归一化、单位换算、FTS5 检索、thesis-check schema 单测。
- `npm run build`：前端打包不回归。
- 真实链路：核对 8-K 附件被抓到、分部收入入库、`broken/weakened` 判定附带可点击 quote。

## 12. 已决策

- **D1**：“卖股”两种情况都纳入——公司事件（8-K）+ 内部人交易（**Form 4/3/5**）；归类交给 DeepSeek 判断，代码不写死规则。
- **D2**：纳入修正案 10-K/A、10-Q/A、8-K/A（按 filing 分键保留，标记被修正口径）。
- **D3**：**添加持仓时后台预提取**最近 8 份业绩 filing + 内部人交易窗口（`POST /api/holdings/:ticker/prefetch`）。

## 13. 实施时可再定的小问题（不阻塞开工）

- Form 4 回溯窗口取“近 12 个月”还是“最近 N 份”？（建议近 12 月且上限 ~20 份，避免老活跃票拉爆）
- 内部人交易在持仓页是并入对应 thesis 验证，还是单独一个“内部人动向”信息块？（建议单独块 + 验证时作为证据可被引用）
