# PROJECT GUIDE — 持仓研究与回测工作台

> **本文档是人与 AI 协作开发的桥梁。**
> 它描述系统的真实形态：架构、技术栈、每个模块的职责与内部逻辑。
> 改代码时同步更新本文档；要新功能时，在文末「开发意图区」写下需求即可，
> AI 据此文档定位模块并实施，不需要你阅读源码。

---

## 1. 项目定位

本地优先的个人投资工作台，核心用户是主动投资者。三大能力：

1. **持仓管理**：手动或 IBKR 同步持仓，记录持仓逻辑与风险点
2. **SEC 基本面研究**：自动拉取 10-K/10-Q/8-K，提取财务指标，AI 生成摘要，AI 检验持仓逻辑是否仍然成立（RAG）
3. **策略回测**：ETF 规则回测引擎（UI 当前未挂载，引擎保留）

当前为单用户本地阶段；上线时启用 Supabase Auth 支持多用户（见 §7 路线图）。

## 2. 技术栈

| 层 | 选型 | 说明 |
|----|------|------|
| 前端 | React 19 + Vite 7 | SPA，ECharts 图表，lucide-react 图标 |
| 后端 | **Hono** + @hono/node-server | 常驻 Node 进程，分域路由 |
| 数据库 | **PostgreSQL 17**（Docker/云）/ PGlite（本地裸跑兜底） | 同一套 SQL，`DATABASE_URL` 决定 |
| LLM | DeepSeek（JSON mode） | 唯一出口 `server/services/deepseek.mjs` |
| 外部数据 | Yahoo Finance（行情）、SEC EDGAR（财报）、IBKR Gateway（券商） | |
| 部署 | Docker Compose（app + postgres） | 生产模式 Hono 同源服务 API + 静态文件 |
| 测试 | node:test，27 用例 | `npm test` |

## 3. 如何启动

```bash
# A. 本地开发（无需 Docker，数据落 PGlite 文件）
npm install
npm start                 # API :8787 + Vite :5173，浏览器开 http://127.0.0.1:5173

# B. Docker 一键启动（生产形态，数据落 Postgres）
docker compose up -d --build     # 浏览器开 http://127.0.0.1:8787
# 改端口：APP_PORT=9000 docker compose up -d

# C. 测试与构建
npm test                  # 27 个用例（含真实子进程启动 API 的集成测试）
npm run build             # 前端生产构建到 dist/
```

环境变量（`.env.local`，`npm start`/`npm run api` 自动加载；Docker 用 compose 的 environment 或宿主环境变量）：

| 变量 | 必需 | 说明 |
|------|------|------|
| `DEEPSEEK_API_KEY` | AI 功能需要 | 缺失时策略整理走本地规则 fallback，filing 摘要/论点检验返回错误提示 |
| `DATABASE_URL` | Docker/云必需 | 不设则用 PGlite（`DATA_DIR/pglite`） |
| `SEC_USER_AGENT` | 建议 | SEC 要求的 UA，格式 `App/版本 邮箱` |
| `IBKR_BASE_URL` | 可选 | 默认 `https://127.0.0.1:5001/v1/api`；Docker 内自动用 `host.docker.internal` |
| `PORT` / `HOST` / `SERVE_STATIC` | 可选 | 默认 8787 / 127.0.0.1 / 关；Docker 镜像内置 0.0.0.0 + 开 |

## 4. 如何部署

**云端容器部署（Railway / Fly / Render 等）**：
1. 用仓库根目录的 `Dockerfile` 构建（多阶段，最终镜像只含生产依赖 + dist）
2. 注入 `DATABASE_URL`（托管 Postgres 或 Supabase）、`DEEPSEEK_API_KEY`、`SEC_USER_AGENT`
3. 不要部署到 Serverless 函数平台——SEC 抓取/论点检验是数十秒级长任务

**切换到 Supabase**：`DATABASE_URL` 指向 Supabase 的连接串（用 connection pooler 的 5432 直连串），首次启动自动建表。

**IBKR 注意**：Gateway 必须与用户同机（IBKR 安全模型限制）。云部署后 IBKR 同步功能仅在本地实例可用，或需迁移到 IBKR OAuth Web API（路线图项）。

## 5. 模块组合方式（架构）

```
浏览器 (React SPA)
│  dev: Vite :5173 → API :8787（CORS）
│  prod: 同源 :8787（Hono 静态托管 dist/）
▼
server.mjs（入口）──► server/app.mjs（Hono app：CORS → 路由 → 404）
                          │
        ┌─────────────────┼──────────────────────┐
        ▼                 ▼                      ▼
   routes/*.mjs      （HTTP 层：取参、校验、错误→JSON）
        │
        ▼
   services/*.mjs    （域逻辑层：不碰 HTTP，函数第一个参数都是 db）
        │                                  │
        ▼                                  ▼
   server/db.mjs ──► Postgres/PGlite   外部服务：Yahoo / SEC EDGAR / DeepSeek / IBKR
```

**前端数据流**：状态全部集中在 `src/views/PortfolioApp.jsx`（持仓、SEC 缓存、IBKR 状态、UI 状态），通过 props 下发给纯展示组件。持仓与论点检验结果持久化在浏览器 localStorage（key 见 `src/lib/catalog.js`）。

**典型请求链路**（以"AI 检验持仓逻辑"为例）：
```
HoldingDetail 按钮 → PortfolioApp.runHoldingThesisCheck()
→ POST /api/holdings/:ticker/thesis-check        (routes/holdings.mjs)
→ thesisService.runThesisCheck()                  (services/)
   ① deepseek: 中文逻辑 → 英文检索关键词
   ② Postgres 全文检索 sec_filing_chunks（GIN 索引）+ 读 sec_filing_extracts
   ③ deepseek: 逐条验证 → verdict/premises/evidence JSON
→ 结果缓存到 holding_thesis_checks（按 thesis 哈希 + 最新 filing 失效）
→ 前端渲染徽章（自洽·有据 / 逻辑减弱 / 前提不成立 / 无证据）
```

## 6. 模块内部逻辑

### 6.1 后端 `server/`

| 文件 | 内部逻辑 |
|------|----------|
| `db.mjs` | 数据库适配器。`getDb()` 按 `DATABASE_URL` 返回 pg Pool 或 PGlite，统一接口 `{query($n参数), exec(多语句DDL), tx(事务)}`。`schemaSql` 是全部 13 张表的唯一定义处，启动时幂等执行 |
| `util.mjs` | 纯工具：ticker/accession 清洗、HTML→纯文本（SEC 文档解析核心）、LLM 输出 JSON 容错解析、FNV 哈希 |
| `routes/market.mjs` | `GET /api/market/overview`（五大指数，60s 缓存）；`GET /api/prices/:ticker`（日线全量） |
| `routes/ibkr.mjs` | status（含自动重新初始化 brokerage session）/ accounts / snapshot（读库）/ sync（拉 Gateway 写库） |
| `routes/strategy.mjs` | `POST /api/parse-strategy`：先试 DeepSeek，失败降级本地规则，永远 200 + `source` 标记 |
| `routes/sec.mjs` | company（CIK 解析）/ filings（列表）/ report（分析报告）/ summary（单文件 AI 摘要）/ `.pdf`（文本转 PDF 下载） |
| `routes/holdings.mjs` | prefetch（202 异步预提取该 ticker 的 filings）/ thesis-check（见 §5 链路） |
| `services/cache.mjs` | TTL 定义：行情 12h、ticker map 7d、filings/companyfacts 6h、文件原文/PDF 7d、大盘 60s |
| `services/yahoo.mjs` | Yahoo chart API → `{date, close}[]`，缓存优先，源站失败回退 stale 缓存 |
| `services/secClient.mjs` | SEC 限速串行队列（150ms 间隔）；ticker map / submissions / companyfacts / filing 原文四类抓取，只保留 10-K/Q/8-K 业务文件 |
| `services/deepseek.mjs` | `deepseekChat({model, system, user})` JSON-mode 封装。**所有 LLM 调用都走这里**——将来换模型/接 AI SDK 只改此文件 |
| `services/strategyService.mjs` | 自然语言策略整理：DeepSeek 路径 + 纯正则 fallback（识别回撤百分比、杠杆禁用、退出条件） |
| `services/secReportService.mjs` | 报告组装：filings + companyfacts + 最新 filing 的 inline XBRL + AI insights → `buildSecAnalysisReport`(src/secReport.mjs) → 版本化写入 sec_report_versions/facts |
| `services/extractService.mjs` | RAG 入库管道：HTML 表格提取、Form 4 内部人交易 XML 解析、8-K 附件抓取、DeepSeek 结构化提取（带 quote 溯源）→ sec_filing_extracts；正文切 1500 字符 chunk → sec_filing_chunks。状态机 pending/done/skipped/error 防重 |
| `services/thesisService.mjs` | 论点检验两步 agent（见 §5）；缓存键 = (ticker, thesis哈希, 最新accession)，新 filing 自动失效 |
| `services/pdfService.mjs` | filing 原文 → htmlToText → PDFKit 排版（45 万字符截断、页码），base64 缓存 |
| `services/ibkrClient.mjs` | Gateway HTTP 客户端（自签证书豁免、1.8s 超时）；positions 先试 portfolio2 API，400/404/405 回退分页旧 API；sync = accounts+positions+ledger → `storeIbkrSync` |

### 6.2 前后端共享域模块 `src/*.mjs`

| 文件 | 内部逻辑 |
|------|----------|
| `secReport.mjs` | 纯函数：companyfacts XBRL → 季度指标（YoY、毛利率、FCF，按 fiscal quarter 去重取最新）；inline XBRL 解析补最新季度；报告组装与修订 diff；AI 摘要规整与占位文本过滤 |
| `ibkrSync.mjs` | IBKR 数据规整（多种字段名兼容）+ 异步存取（事务写入，消失的持仓标记 closed_at 而非删除） |
| `strategyRules.mjs` | 从策略文本派生结构化条件 conditions[]（回撤阈值、目标资产、恢复退出） |
| `marketSeries.mjs` | `mergePriceData`：只保留所有外部序列都有价的日期，防跨资产错位 |
| `holdingNotes.mjs` / `ibkrCash.mjs` | 持仓笔记条目规整、建仓计划规整；IBKR 现金汇总（BASE 行优先防重复计数） |

### 6.3 前端 `src/`

| 文件 | 内部逻辑 |
|------|----------|
| `main.jsx` | 入口，仅挂载 PortfolioApp |
| `views/PortfolioApp.jsx` | **状态中枢**。持仓 CRUD（IBKR 持仓的笔记以 ibkr-note 形式存本地）、IBKR 连接编排（boot 自动同步）、SEC 数据加载（选中持仓自动拉 filings+report，3 分钟轮询，摘要双 worker 并发）、论点检验调用与持久化 |
| `views/BacktestView.jsx` | 回测工作台（自包含：策略编辑、条件表、自然语言整理、收益/回撤图）。**当前未挂载**；恢复方式 = main.jsx 里渲染它 |
| `components/HoldingDetail.jsx` | 四页签详情。持仓逻辑页签含 AI 检验结果渲染（徽章/论据拆解/证据链接到 PDF） |
| `components/SecReportPanel.jsx` | 基本面面板 + 三种 ECharts 配置（营收 YoY、利润率、净利/FCF） |
| `components/SectorHeatmap.jsx` | 账户总览：treemap 热力图（面积=仓位、颜色=日涨跌）、今日变动汇总 |
| `engine/backtest.js` | 回测内核纯函数。策略合同：`rules.conditions[]`（triggerAsset/metric/operator/value/targetAsset/targetWeight/sourceAsset/priority）；旧 thresholds 仅 normalizeConditions 兼容 |
| `lib/catalog.js` | 资产清单、行业/公司名映射、localStorage key 常量 |
| `lib/holdings.js` | 持仓规整、IBKR 快照→展示持仓合并（笔记按 conid/symbol 匹配） |
| `api/client.js` | `apiBase`：dev→`http://127.0.0.1:8787`，生产→同源空串，`VITE_API_BASE` 可覆盖 |

### 6.4 数据表（Postgres，定义见 `server/db.mjs`）

| 表 | 用途 |
|----|------|
| `price_cache` / `sec_cache` | 行情与 SEC 各类响应的 TTL 缓存（payload 为 JSON 文本） |
| `sec_report_versions` / `sec_report_facts` | 分析报告版本快照 / 季度指标事实表（溯源 tag+accession） |
| `sec_filing_summaries` | 单 filing AI 摘要（永久缓存） |
| `sec_filing_extracts` / `sec_filing_extract_status` | RAG 结构化提取结果 / 提取状态机 |
| `sec_filing_chunks` | RAG 文本块，GIN 全文索引 |
| `holding_thesis_checks` | 论点检验结果缓存 |
| `ibkr_accounts/positions/balances/sync_runs` | IBKR 同步快照（软关闭 closed_at） |

**前端 localStorage**：`portfolio-backtest:holdings:v1`（持仓+笔记）、`ibkr-account:v1`（选中账户）、`thesis-checks:v1`（检验结果副本）。

### 6.5 API 一览

```
GET  /api/health
GET  /api/market/overview
GET  /api/prices/:ticker
POST /api/parse-strategy            {description, existingStrategy?}
GET  /api/ibkr/status|accounts|snapshot
POST /api/ibkr/sync                 {accountId?}
GET  /api/sec/company/:ticker
GET  /api/sec/filings/:ticker?limit&force
GET  /api/sec/report/:ticker?force
GET  /api/sec/filings/:ticker/:accession/summary
GET  /api/sec/filings/:ticker/:accession.pdf
POST /api/holdings/:ticker/prefetch
POST /api/holdings/:ticker/thesis-check   {thesisItems[], riskItems[], force?}
```

## 7. 路线图（按优先级）

1. **持仓数据上库**：localStorage → Postgres（`/api/portfolio` CRUD），多用户的前提
2. **Supabase Auth**：前端接 supabase-js 登录；Hono 加 JWT 中间件（JWKS 本地验签）；所有表加 `user_id` 列
3. **Agent 化升级**：引入 Vercel AI SDK（`ToolLoopAgent`）或 Mastra（原生 Hono 适配）。改造顺序：
   - `thesisService` → 工具循环 agent（检索工具 = chunks 全文搜索 + extracts 查询，可多轮迭代检索）
   - `extractService` → 提取 workflow（表格/章节并行提取 + 校验）
   - 新增"投研日报 agent"：定时扫描持仓的新 filing → 摘要推送
   - 所有 LLM 调用经 `services/deepseek.mjs` 收口，替换为 AI SDK provider 即可多模型
4. **IBKR 云端方案**：OAuth Web API 替代本地 Gateway（云部署需要）
5. **TypeScript 渐进迁移**：新文件 .ts 优先，合同类模块（conditions、SEC facts）先行
6. **回测视图恢复**：挂载 `BacktestView`，加视图切换

## 8. 开发意图区（在这里写需求）

> 用法：在下面追加条目描述你要的功能/修改，然后把本文档发给 AI（或直接说"按 PROJECT_GUIDE 意图区开发"）。AI 会根据 §5/§6 定位模块、实施、跑测试、更新本文档相应章节后勾选。

- [ ] （示例）给持仓详情加一个"新闻"页签，聚合该 ticker 近 7 天新闻并 AI 摘要

## 8.5 IBKR 连接排查（Docker 场景）

IBKR Client Portal Gateway 是宿主机上的本地 Java 服务，需交互式登录。容器内应用通过 `host.docker.internal:5001` 访问它。连不上时按顺序排查：

1. **Gateway 是否在跑**：`lsof -nP -iTCP:5001 -sTCP:LISTEN`。没有进程 → 启动它。
2. **启动 Gateway**（本机 Java 经 Homebrew 装在 `/opt/homebrew/opt/openjdk/bin`，未进系统 PATH）：
   ```bash
   cd clientportal.gw
   PATH="/opt/homebrew/opt/openjdk/bin:$PATH" nohup bash bin/run.sh root/conf.yaml > /tmp/ibkr-gw.log 2>&1 &
   ```
3. **浏览器登录**：打开 `https://localhost:5001`，用 IBKR 账号 + 2FA 登录（自签证书，浏览器需手动信任）。
4. **回到应用点「刷新状态」**：positions 会同步入库。
5. 应用报错信息已能区分故障类型（`server/services/ibkrClient.mjs` 的 `describeOfflineError`）：`gateway: offline` + ECONNREFUSED = Gateway 没起；超时 = 被 `conf.yaml` 的 `ips.allow` 白名单拦（Docker 来源 IP 需匹配 `192.*`）。

要点：
- **登录链接自动用 `localhost`**：应用内部连 `host.docker.internal`，但展示给用户的 loginUrl 会改写成 `localhost`（浏览器可达）。非标准环境可用 `IBKR_LOGIN_URL` 覆盖。
- **只在本地用 IBKR 的更简方案**：`npm run api`（原生跑后端，默认连 `127.0.0.1:5001`，无 Docker 网络问题，等同重构前路径）。
- **云部署**：Gateway 在云上不可达，需迁 IBKR OAuth Web API（路线图 §7 第 4 项）。

## 9. 已知事项

- 「添加股票」弹窗无触发入口（历史遗留，组件在 `AddHoldingModal.jsx`，接一个按钮即可启用）
- `prefetchTickerFilings` 的 insider filings 分支实际恒为空（filings 列表只含业务文件），Form 4 提取逻辑写好未通电
- 旧 `data/market-cache.sqlite` 已不再使用，确认无需要后可删除
- 测试中 1 条用例（ibkr-sync 存储）依赖 PGlite 首次 WASM 加载，单条耗时 ~1.3s 属正常
