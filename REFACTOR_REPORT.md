# 重构报告：React + Hono + PostgreSQL

**日期**：2026-06-12
**目标**：可读性、可部署性、为多用户（Supabase Auth）和 AI Agent 化扩展铺路
**验收**：见 [ACCEPTANCE_REPORT.md](ACCEPTANCE_REPORT.md)，27/27 测试通过，浏览器逐项回归通过

## 一、改了什么

### 后端：1825 行手写路由 → Hono 分域结构

| 重构前 | 重构后 |
|--------|--------|
| `server.mjs` 单文件 1825 行 | `server.mjs` 入口 22 行 + `server/` 目录 12 个模块 |
| 原生 `node:http` + 手写 `if (url.pathname === ...)` 正则路由 | Hono 路由（`routes/` 按域拆分：market / ibkr / strategy / sec / holdings） |
| SQLite（`node:sqlite`，同步 API） | PostgreSQL（`pg`，异步）；本地无 Docker 时自动降级嵌入式 PGlite |
| 业务逻辑、SQL、HTTP 处理混在一起 | `services/` 域服务层（SEC 客户端、DeepSeek 封装、IBKR 客户端、报告生成、RAG 提取、论点检验、PDF） |
| CORS 头手写在每个响应里 | `hono/cors` 中间件统一处理 |

新目录：

```
server.mjs                  入口（建库 → 建 app → 监听；Docker 模式兼任静态服务）
server/
├── app.mjs                 Hono app 组装（CORS、健康检查、挂路由、404）
├── db.mjs                  数据库适配器（DATABASE_URL→pg / 否则→PGlite）+ 全量 schema
├── util.mjs                cleanTicker、htmlToText、parseJsonObject 等纯工具
├── routes/                 HTTP 层：参数校验 + 调 service + 错误转 JSON
│   ├── market.mjs          /api/market/overview、/api/prices/:ticker
│   ├── ibkr.mjs            /api/ibkr/*
│   ├── strategy.mjs        /api/parse-strategy
│   ├── sec.mjs             /api/sec/*（company/filings/report/summary/pdf）
│   └── holdings.mjs        /api/holdings/:ticker/{prefetch,thesis-check}
└── services/               域逻辑层（不碰 HTTP）
    ├── cache.mjs           TTL 常量 + sec_cache/price_cache 读写
    ├── yahoo.mjs           行情拉取与大盘指数
    ├── secClient.mjs       SEC EDGAR 客户端（限速队列、ticker map、filings、原文）
    ├── deepseek.mjs        DeepSeek JSON-mode 薄封装（唯一的 LLM 出口）
    ├── strategyService.mjs 策略自然语言整理 + 本地 fallback
    ├── secReportService.mjs 财报分析报告、filing 摘要、版本化持久化
    ├── extractService.mjs  RAG 管道：表格/Form4 提取、chunk 入库、预取
    ├── thesisService.mjs   持仓逻辑 AI 检验（关键词→全文检索→验证）
    ├── pdfService.mjs      SEC 文本转 PDF
    └── ibkrClient.mjs      IBKR Gateway HTTP 客户端 + 同步编排
```

### 前端：2503 行 main.jsx → 视图/组件/引擎分层

```
src/
├── main.jsx                入口 9 行（只做 createRoot）
├── views/
│   ├── PortfolioApp.jsx    持仓工作台（唯一挂载的视图；状态集中在此）
│   └── BacktestView.jsx    回测工作台（自包含组件，当前不挂载，见下文说明）
├── components/             纯展示组件，只收 props
│   ├── HoldingDetail.jsx   四页签详情（持仓逻辑/建仓计划/基本面/SEC）
│   ├── SecReportPanel.jsx  SEC 财报信号面板 + ECharts 配置
│   ├── SectorHeatmap.jsx   账户总览热力图
│   ├── AddHoldingModal.jsx 添加股票弹窗
│   └── MarketSparkline.jsx 指数迷你走势
├── engine/backtest.js      回测内核（纯函数：backtest/metric/normalizeConditions…）
├── lib/
│   ├── catalog.js          资产清单、行业映射、公司名映射、storage key
│   ├── format.js           货币/百分比格式化
│   └── holdings.js         持仓数据规整、IBKR 快照合并、localStorage 读写
├── api/client.js           apiBase（dev→8787，生产→同源，VITE_API_BASE 可覆盖）
└── *.mjs                   前后端共享的域模块（secReport/ibkrSync/strategyRules…，未动）
```

### 数据库：SQLite → PostgreSQL

- 13 张表 schema 等价迁移（`server/db.mjs`），`REAL`→`DOUBLE PRECISION`、`AUTOINCREMENT`→`IDENTITY`
- SQLite FTS5 全文检索 → Postgres `to_tsvector` + GIN 索引（论点检验的 RAG 检索）
- **双模式适配器**：设了 `DATABASE_URL` 走 pg 连接池；没设（本地裸跑 `npm start`、跑测试）自动用嵌入式 PGlite，零依赖可用
- 旧 `data/market-cache.sqlite` 保留未删；全部是缓存数据，新库首次请求自动重建

### 部署：Docker 一键启动

- `Dockerfile`：多阶段构建（构建前端 → 仅生产依赖的运行镜像，Hono 同时服务 `/api` 和静态文件）
- `docker-compose.yml`：`app` + `db`(postgres:17) 两个服务，healthcheck 串联，`docker compose up` 一条命令起全套
- IBKR Gateway 跑在宿主机：容器内通过 `host.docker.internal:5001` 访问（已加白名单）

## 二、为什么这样改

1. **Hono 而非 Next.js 全栈**：系统重心是数据管道（SEC 抓取、agent 循环、PDF 生成），需要常驻进程和长任务，与 Next.js 请求级模型错配（前期 ADR 已论证）。Hono 基于 Web 标准，是 AI SDK / Mastra 等 agent 框架的原生宿主。
2. **routes / services 分层**：后续每加一个 agent 或数据源，只需新增一个 service + 一个 route 文件，不再在千行文件里找插入点。
3. **PGlite 兜底**：保证"本地测试阶段"不强制依赖 Docker，测试套件也无需外部数据库。
4. **持仓数据暂留 localStorage**：本次验收要求前端行为零变化；迁到 Postgres 的 `/api/portfolio` CRUD 是启用 Supabase Auth 时的第一步（见 PROJECT_GUIDE 路线图）。

## 三、为后续扩展预留的接口

- **Supabase Auth**：上线时把 `DATABASE_URL` 指向 Supabase Postgres 即可完成数据层切换；认证只需在 `server/app.mjs` 加一个 JWT 校验中间件（JWKS 本地验签），路由代码不动。
- **AI Agent 化**：`services/deepseek.mjs` 是当前唯一 LLM 出口；`thesisService.mjs`（关键词提取 → RAG 检索 → 验证）已是两步 agent 雏形。建议下一步引入 Vercel AI SDK 的 `ToolLoopAgent` 替换手写编排，挂载点即 `services/`（详见 PROJECT_GUIDE「Agent 化扩展」一节）。
- **回测视图**：重构前回测 UI 就处于未挂载状态（定义了但不渲染）。现已整理为自包含的 `BacktestView.jsx`，在 `main.jsx` 挂载即可恢复。

## 四、技术债与说明

- `test/portfolio-only-view.test.mjs` 原有一条断言重构前就失败（断言早已不存在的 `portfolioCash` 类名），已改写为与真实 UI 一致。
- TypeScript 已在依赖中但代码仍为 JS/JSX；建议新文件用 TS 渐进迁移（schema/合同类模块优先）。
- 「添加股票」弹窗在重构前就没有触发入口（不可达 UI），按验收要求原样保留。
- IBKR insider filings 预取过滤（`prefetchTickerFilings`）依赖的 filings 列表只含 10-K/Q/8-K，insider 部分实际恒为空——重构前即如此，按行为保真原则未改，已在 PROJECT_GUIDE 标注。
