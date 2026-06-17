# Yahoo Finance 估值数据 + AI DCF 分析 — 实现说明

状态：已实现，待用户验收。分支：`feature/management-analysis`（未提交）。

## 1. 功能概述

在持仓详情的 **基本面** 页签内，紧跟已有的 SEC 文件信号面板之下，新增一个估值分析面板：

1. 从 Yahoo Finance 拉取估值硬数据（市盈率、市销率、市净率、EV/EBITDA、增长率、利润率、自由现金流、分析师目标价等）。
2. 用 ECharts 把估值倍数和「价格 vs 分析师目标价」画成图。
3. 让 DeepSeek 基于这些硬数据做 **三情景（熊市/基准/牛市）DCF 估值判断**，输出高估/合理/低估结论、关键驱动因素和风险。
4. **关键设计**：AI 不直接输出公允价值数字。AI 只给出每个情景的 DCF 假设参数（收入增长率、FCF 利润率、折现率、永续增长率）和定性判断；真正的贴现现金流计算由后端一段确定性代码完成。这是为了避免 LLM 在多步算术上的幻觉风险——这一点在最初的方案讨论中被识别为「最高风险点」，因此在工程上做了硬约束，而不是仅靠 prompt 约束。

## 2. 数据来源：Yahoo Finance v10 quoteSummary

### 2.1 为什么不能直接复用现有的 `getPrices`

[`server/services/yahoo.mjs`](server/services/yahoo.mjs) 原有的 `getPrices`/`getMarketOverview` 走的是 v8 `/chart` 端点，只有历史收盘价和指数报价，没有市盈率、市净率、自由现金流等估值字段。这些字段只存在于 v10 `quoteSummary` 端点的 `summaryDetail`/`defaultKeyStatistics`/`financialData` 模块里。

### 2.2 实测发现：v10 需要 crumb，而且对 User-Agent 敏感

实现前先做了一次现场验证（直接对 Yahoo 发请求测试）：

| 端点 | 是否需要 crumb | 实测结果 |
|---|---|---|
| v8 `/chart`（现有功能在用） | 不需要 | 200 OK，稳定 |
| v10 `quoteSummary`（新功能要用） | **需要** cookie + crumb | crumb 流程本身可以跑通，但用非浏览器 UA 请求 `getcrumb` 会拿到一个无效的「错误 JSON 当作 crumb」返回，导致后续请求 401；换成真实浏览器 UA 后流程正常 |
| v7 `/quote`（备用） | 不需要 | 可用，但字段比 v10 少很多 |

由此得到的实现结论：

- **必须用浏览器风格的 User-Agent**（`BROWSER_UA` 常量），否则 crumb 接口会返回伪造的 JSON 错误体而不是真正的 crumb 字符串。
- crumb + cookie 会话在内存里缓存（`crumbSession`，TTL 50 分钟），不是每次请求都重新走一遍 cookie→crumb 流程。
- 如果用缓存的 crumb 请求返回 401（crumb 过期/失效），自动刷新一次 crumb 后重试一次。
- 如果 v10 整体失败（限流、网络问题等），退化到 v7 `/quote`（字段少但不需要 crumb）。
- 如果两者都失败，退回到数据库里的旧缓存（7 天宽限期），数据库也没有才真正抛错。

代码位置：[`server/services/yahoo.mjs`](server/services/yahoo.mjs)
- `fetchCrumbSession` / `getCrumbSession`：cookie+crumb 会话获取与内存缓存
- `fetchQuoteSummaryRaw`：v10 请求 + 401 自动重试
- `fetchQuoteV7Raw`：v7 备用
- `normalizeValuationPayload(ticker, quoteSummaryJson, quoteV7Json)`：**纯函数**，把 Yahoo 的 `{raw, fmt}` 嵌套结构压平成统一的 `valuation` 对象，导出用于单测，不依赖网络。
- `getValuation(db, ticker, {force})`：对外入口，串联缓存读取→v10→v7 fallback→stale cache fallback。

### 2.3 缓存策略

估值倍数类数据日内基本不变（不像价格那样分钟级波动），所以用了较长的 TTL：

- `valuationTtlMs = 18 小时`（[`server/services/cache.mjs`](server/services/cache.mjs)），复用已有的 `sec_cache` 通用缓存表，cache key 为 `valuation:{TICKER}`。
- 这个长 TTL 同时也是限流问题的解法：单 ticker 每天大约只会真正打 1 次 Yahoo，3 分钟轮询定时器（见下文）不会触发它的强制刷新。

## 3. AI 估值判断 + 确定性 DCF 重算

### 3.1 数据流

```
Yahoo 估值硬数据 (getValuation)
        │
        ├─→ DeepSeek (只产出 DCF 假设参数 + 定性判断)
        │        scenarios: [{case, revenueGrowth, fcfMargin, discountRate, terminalGrowth}, ...]
        │        verdict / confidence / keyDrivers / risks / reasoning
        │
        ▼
deterministicDcf()  ← 后端纯函数，用标准两阶段 DCF 公式重新计算每个情景的 fairValuePerShare
        │
        ▼
buildValuationReport()  ← 组装最终报告（含图表数据），AI 给出的任何数字结果都被忽略，
                           只有 AI 给的「假设参数」被采用
```

### 3.2 DCF 公式（[`src/valuationReport.mjs`](src/valuationReport.mjs:deterministicDcf)）

标准两阶段模型：

1. 用 `revenueGrowth` 把当前营收滚动 5 年，每年营收 × `fcfMargin` 得到该年自由现金流。
2. 用 `discountRate` 把 5 年现金流折现到现值并求和。
3. 用 Gordon Growth 公式算永续价值：`第5年FCF × (1+terminalGrowth) / (discountRate - terminalGrowth)`，再折现到现值。
4. 企业价值 = 5年现值之和 + 永续价值现值；股权价值 = 企业价值 + 净现金（现金 − 负债）；每股公允价值 = 股权价值 / 流通股数。
5. 防御性校验：`discountRate` 必须大于 `terminalGrowth`（否则永续价值公式会发散到负数/无穷），股数和营收必须为正数，否则返回 `null` 而不是一个荒谬的数字。

三个情景（熊市/基准/牛市）各自独立跑一遍这个函数，再取 `{low: 熊市公允价值, mid: 基准公允价值, high: 牛市公允价值}` 作为公允价值区间，并算出每个情景相对当前价的涨跌幅 `upsidePercent`。

### 3.3 AI 角色边界（防幻觉的核心约束）

[`server/services/valuationService.mjs`](server/services/valuationService.mjs:analyzeValuationWithDeepSeek) 的 system prompt 明确要求 DeepSeek：

- **只能**给出三组情景的 4 个假设参数（增长率/FCF利润率/折现率/永续增长率），**禁止自己算出或输出公允价值/每股价值等结果数字**——prompt 明确告知这些数字会被忽略。
- 定性结论（`keyDrivers`、`risks`）必须引用给定的具体数字，不能编造（沿用了 SEC 报告功能里已经验证过的反幻觉写法）。
- 如果没配置 `DEEPSEEK_API_KEY`，或调用失败，或返回的 `scenarios` 不是合法数组，自动退化到 [`buildFallbackValuationInsights`](src/valuationReport.mjs:buildFallbackValuationInsights)：用硬数据本身（实际营收增速、FCF/营收比例）启发式生成三组假设，verdict 留空，由系统按基准情景涨跌幅自动推导（≥15% 涨幅→低估，≤-15%→高估，其余→合理）。

这样设计的结果是：**无论 AI 是否可用、是否产生幻觉性的数字，最终展示给用户的公允价值永远来自同一段确定性 DCF 代码**，AI 的不确定性被限制在「假设参数是否合理」和「定性叙述」这两个低风险维度上。

### 3.4 持久化与版本

- 表 `valuation_reports`（[`server/db.mjs`](server/db.mjs)）：`(ticker, version_id)` 为主键，存完整报告 JSON。
- `version_id` 是 `ticker + 当前价 + scenarios JSON` 的简单哈希，价格或假设变化就会生成新版本，但**不会**无限增长——同一 ticker 6 小时内的请求直接读最近一条记录（`REPORT_TTL_MS = 6 小时`），不重新调用 Yahoo/DeepSeek。
- 这个 6 小时报告级缓存和 18 小时 Yahoo 数据缓存是两层独立缓存：前者省 DeepSeek 调用，后者省 Yahoo 调用。`force=1` 会绕过两层缓存。

## 4. API

`GET /api/valuation/:ticker?force=1`

[`server/routes/valuation.mjs`](server/routes/valuation.mjs) → [`getValuationReport`](server/services/valuationService.mjs)，错误时返回 `502 {error}`，与现有 `/api/sec/report/:ticker` 的错误处理风格一致。

响应体形状（节选）：

```json
{
  "ticker": "MSFT",
  "companyName": "Microsoft Corp",
  "verdict": "合理",
  "confidence": 0.65,
  "valuation": { "currentPrice": 398.89, "multiples": {...}, "financials": {...}, "analyst": {...} },
  "scenarios": [
    { "case": "bear", "revenueGrowth": 0.08, "fcfMargin": 0.25, "discountRate": 0.11, "terminalGrowth": 0.02, "fairValuePerShare": 320.5, "upsidePercent": -19.6 },
    { "case": "base", "...": "..." },
    { "case": "bull", "...": "..." }
  ],
  "fairValueRange": { "low": 320.5, "mid": 410.2, "high": 510.8 },
  "keyDrivers": [{ "label": "云业务增速", "detail": "..." }],
  "risks": [{ "severity": "medium", "detail": "..." }],
  "reasoning": "...",
  "charts": { "multiples": {...}, "priceTarget": {...} },
  "disclaimer": "AI 仅提供 DCF 假设参数与定性判断；公允价值由系统使用标准两阶段 DCF 公式重新计算，未采用 AI 直接给出的数字。本报告不构成投资建议。",
  "source": "deepseek" // 或 "fallback" / "cache"
}
```

## 5. 前端

- 新组件 [`src/components/ValuationPanel.jsx`](src/components/ValuationPanel.jsx)：估值摘要卡片（现价/公允价值区间/估值判断徽章）、关键驱动与风险列表、三张 DCF 情景卡（熊市/基准/牛市，各显示假设参数和系统重算出的公允价值与涨跌幅）、两张 ECharts 图（估值倍数柱状图、价格 vs 分析师目标价折线图 + markLine）。
- 渲染位置：[`src/components/HoldingDetail.jsx`](src/components/HoldingDetail.jsx) 的 `fundamentals`（基本面）页签内，紧跟在 `SecReportPanel` 之后——对应用户选择的「扩展基本面页签」而不是新开页签。
- 状态管理：[`src/views/PortfolioApp.jsx`](src/views/PortfolioApp.jsx) 新增 `valuationReports`/`valuationReportStatus` state 和 `loadValuationReport(symbol, force)`，在展开持仓时与 `loadSecReport` 一起触发（非强制，命中缓存即返回）。
- **特意没有**把 `loadValuationReport` 接入已有的「3 分钟强制刷新」定时器——那个定时器是为 SEC 文件信号设计的，如果对估值也用 `force=true`，会绕开 6 小时报告缓存和 18 小时 Yahoo 缓存，导致每 3 分钟打一次 DeepSeek + 触发 crumb 流程，既浪费成本又增加被 Yahoo 限流的概率。
- 样式复用了 SEC 面板已有的 CSS 类（`secAnalysisPanel`/`secInsightGrid`/`secAlertRail`/`secAiGrid`/`secChartGrid`/`secMiniChart`，包括移动端响应式规则），新增的类只有 DCF 情景卡相关的 `dcfScenarioGrid`/`dcfScenarioCard`/`dcfScenarioAssumptions` 和免责声明的 `valuationDisclaimer`（[`src/styles.css`](src/styles.css)）。

## 6. 文件清单

| 文件 | 改动 |
|---|---|
| `server/db.mjs` | 新增 `valuation_reports` 表 |
| `server/services/cache.mjs` | 新增 `valuationTtlMs` 常量 |
| `server/services/yahoo.mjs` | 新增 crumb 会话管理、`getValuation`、`normalizeValuationPayload`（导出供测试） |
| `server/services/deepseek.mjs` | 新增 `valuationModel` 导出 |
| `server/services/valuationService.mjs` | 新文件：编排 Yahoo + DeepSeek + 持久化 |
| `server/routes/valuation.mjs` | 新文件：`GET /api/valuation/:ticker` |
| `server/app.mjs` | 挂载 `valuationRoutes` |
| `src/valuationReport.mjs` | 新文件：`deterministicDcf`、`buildFallbackValuationInsights`、`buildValuationReport`、图表数据组装，纯逻辑无网络依赖 |
| `src/components/ValuationPanel.jsx` | 新文件：前端面板 |
| `src/components/HoldingDetail.jsx` | 在基本面页签渲染 `ValuationPanel` |
| `src/views/PortfolioApp.jsx` | 估值 state + 加载函数 + 透传 props |
| `src/styles.css` | 新增 DCF 情景卡样式 |
| `test/valuation-report.test.mjs` | 新文件：单元测试 |

## 7. 验收测试计划

### 7.1 自动化测试（已跑过）

- [x] `node --test test/valuation-report.test.mjs` — 11 个用例全部通过：
  - `deterministicDcf`：合理假设下产出正数公允价值；折现率 ≤ 永续增长率时返回 `null`；输入缺失/非法时返回 `null`；增长率假设更高时公允价值也更高（单调性检查）。
  - `buildFallbackValuationInsights`：无 AI 时三组情景的增长率/折现率按熊市<基准<牛市的方向单调排列。
  - `buildValuationReport`：验证 AI 提供数字会被忽略、只用其假设重算；验证 AI 不给 verdict 时按基准情景涨跌幅推导；验证完全无 AI 时退化路径可用。
  - `normalizeValuationPayload`：v10 嵌套结构正确压平；缺数据时抛错；v7 兜底字段正确读取。
- [x] `npm test`（全量 51 个用例）— 新增用例全部通过；2 个预先存在、与本次改动无关的失败（`test/strategy-description-api.test.mjs`，需要 `DEEPSEEK_API_KEY` 才能跑通，在改动前的 base 分支上同样失败，已用 `git stash` 验证）。
- [x] `npm run build` — Vite 生产构建成功，无报错。

### 7.2 人工验收清单（建议在浏览器里逐项确认）

1. **基本展示**：打开任意持仓详情 → 基本面页签 → SEC 文件信号面板下方应出现「Yahoo 估值 + AI DCF」面板。
2. **硬数据正确性**：当前价格、市值与 Yahoo Finance 网页/其他数据源交叉核对一致（允许因缓存有几小时延迟）。
3. **DCF 情景卡**：熊市/基准/牛市三张卡的公允价值应满足 熊市 < 基准 < 牛市；每张卡下方应展示 4 个假设参数（收入增速、FCF 利润率、折现率、永续增长率）。
4. **估值判断徽章**：高估/合理/低估三种颜色（红/灰/绿）渲染正确，且与「基准情景涨跌幅」方向大致吻合（除非 AI 给出了不同方向的判断——这是允许的，AI 判断和确定性涨跌幅可以不完全一致，但应能在 `reasoning` 里看出理由）。
5. **图表**：估值倍数柱状图、价格 vs 分析师目标价折线图（含目标低/均/高三条 markLine）均正常渲染，无 NaN/空白。
6. **无 AI key 场景**：临时移除/清空 `DEEPSEEK_API_KEY` 后请求该接口，应仍返回 200，`source: "fallback"`，三组情景仍存在（启发式生成），风险列表里有一条提示「假设为系统启发式默认值」。
7. **更新按钮**：点击「更新估值」按钮应触发 `force=1` 请求，按钮 disabled 状态在请求期间生效。
8. **限流降级**：模拟 Yahoo v10 持续 429（断网或改错 crumb）时，应自动退到 v7，再退到数据库旧缓存，最终仍尽量返回数据而不是直接报错（除非数据库也完全没有该 ticker 的历史缓存）。
9. **移动端**：缩小浏览器宽度，确认估值面板和情景卡按现有移动端断点正确堆叠为单列，不溢出。
10. **回归检查**：原有 SEC 文件信号面板、AI 检验、建仓计划三个页签功能不受影响。

## 8. 已知限制 / 后续可优化项

- v10 `quoteSummary` 依赖 Yahoo 非公开接口行为（crumb 机制），如果 Yahoo 改变反爬策略，需要相应调整 `BROWSER_UA`/crumb 流程，这是该数据源的固有脆弱性，已通过 v7 fallback + 数据库 stale cache 缓解，但不能完全消除。
- DCF 模型是简化的两阶段模型（5 年显式预测 + 永续价值），没有考虑股权稀释、期权池、分部估值等更复杂的因素，定位是「快速估值参考」而非精算级别的估值模型。
- AI 给出的假设参数本身仍可能不够准确（这是 LLM 判断力的问题，不是算术幻觉问题），需要靠风险列表和免责声明向用户传达不确定性。
