import React from 'react';
import { ExternalLink, FileDown, Plus, Trash2 } from 'lucide-react';
import { normalizeEntryPlan, normalizeHoldingItems } from '../holdingNotes.mjs';
import { apiBase } from '../api/client.js';
import { secCompanyUrl, secFilingsUrl } from '../lib/catalog.js';
import { SecReportPanel } from './SecReportPanel.jsx';

function verdictLabel(r) {
  if (!r) return null;
  if (r.consistency === 'self_contradictory') return { text: '自相矛盾', cls: 'thesisBadgeWarn' };
  if (r.consistency === 'premise_false' || r.verdict === 'broken') return { text: '前提不成立', cls: 'thesisBadgeDanger' };
  if (r.verdict === 'weakened') return { text: '逻辑减弱', cls: 'thesisBadgeWarn' };
  if (r.verdict === 'no_evidence') return { text: '无 filing 证据', cls: 'thesisBadgeNeutral' };
  if (r.verdict === 'supported') return { text: '自洽·有据', cls: 'thesisBadgeOk' };
  return null;
}

// 持仓详情：持仓逻辑（含 AI 检验）/ 建仓计划 / 基本面 / SEC 报告 四个页签。
export function HoldingDetail({
  holding,
  className = '',
  holdingTab,
  setHoldingTab,
  secFilings,
  secStatus,
  secReports,
  secReportStatus,
  filingSummaries,
  filingSummaryStatus,
  thesisChecks,
  thesisCheckStatus,
  expandedThesisItem,
  setExpandedThesisItem,
  updateHoldingItem,
  removeHoldingItem,
  addHoldingItem,
  updateEntryPlan,
  runHoldingThesisCheck,
  loadSecFilings,
  loadSecReport
}) {
  if (!holding) return null;
  const ticker = holding.symbol.trim().toUpperCase();
  const filingPayload = ticker ? secFilings[ticker] : null;
  const filingStatus = ticker ? secStatus[ticker] : null;
  const thesisItems = normalizeHoldingItems(holding.thesisItems, holding.thesis, 'thesis');
  const riskItems = normalizeHoldingItems(holding.riskItems, holding.risk, 'risk');
  const entryPlan = normalizeEntryPlan(holding.entryPlan);
  const plannedShares = entryPlan.batches * entryPlan.sharesPerBatch;

  const checkResult = thesisChecks[ticker];
  const checkSt = thesisCheckStatus[ticker] || 'idle';
  const isChecking = checkSt === 'loading';
  const itemResults = checkResult?.items || [];
  const countSupported = itemResults.filter((r) => r.verdict === 'supported' && r.consistency === 'consistent').length;
  const countWeak = itemResults.filter((r) => r.verdict !== 'supported' || r.consistency !== 'consistent').length;
  const conflicts = checkResult?.crossItemConflicts || [];
  const coverage = checkResult?.coverage;

  return (
    <article key={holding.id} className={`holdingDetail ${className}`.trim()} aria-label="持仓详情" data-holding-detail={ticker}>
      <div className="holdingDetailHeader">
        <div className="holdingDetailMeta">
          <span className="holdingDetailTicker">{ticker}</span>
          {filingPayload?.company?.name && filingPayload.company.name !== ticker && (
            <span className="holdingDetailCompany">{filingPayload.company.name}</span>
          )}
        </div>
        <div className="holdingTabs" role="tablist" aria-label="持仓详情页签">
          <button className={holdingTab === 'thesis' ? 'active' : ''} onClick={() => setHoldingTab('thesis')} role="tab" aria-selected={holdingTab === 'thesis'}>持仓逻辑</button>
          <button className={holdingTab === 'entry' ? 'active' : ''} onClick={() => setHoldingTab('entry')} role="tab" aria-selected={holdingTab === 'entry'}>建仓计划</button>
          <button className={holdingTab === 'fundamentals' ? 'active' : ''} onClick={() => setHoldingTab('fundamentals')} role="tab" aria-selected={holdingTab === 'fundamentals'}>基本面</button>
          <button className={holdingTab === 'sec' ? 'active' : ''} onClick={() => setHoldingTab('sec')} role="tab" aria-selected={holdingTab === 'sec'}>SEC 报告</button>
        </div>
      </div>
      <div className="holdingTabBody" key={`${holding.id}-${holdingTab}`}>
        {holdingTab === 'thesis' ? (
            <div className="holdingThesisWorkspace">
              <section className="holdingListEditor" aria-labelledby={`thesis-title-${holding.id}`}>
                <div className="holdingEditorHead thesisEditorHead">
                  <span id={`thesis-title-${holding.id}`}>持仓逻辑</span>
                  <div className="thesisAiToolbar">
                    {checkResult && (
                      <>
                        {countSupported > 0 && <span className="thesisSumChip thesisSumOk">{countSupported} 自洽</span>}
                        {countWeak > 0 && <span className="thesisSumChip thesisSumWarn">{countWeak} 存疑</span>}
                        {checkResult.checkedAt && (
                          <span className="thesisCheckedAt">
                            {(() => { const m = Math.floor((Date.now() - new Date(checkResult.checkedAt)) / 60000); return m < 1 ? '刚刚检验' : m < 60 ? `${m} 分钟前` : `${Math.floor(m / 60)} 小时前`; })()}
                          </span>
                        )}
                      </>
                    )}
                    <button
                      className="thesisCheckBtn"
                      disabled={isChecking || thesisItems.length === 0}
                      onClick={() => runHoldingThesisCheck(holding, false)}
                      aria-label="AI 检验逻辑"
                    >
                      {isChecking ? '检验中…' : 'AI 检验逻辑'}
                    </button>
                    {checkResult && !isChecking && (
                      <button className="thesisReCheckBtn" onClick={() => runHoldingThesisCheck(holding, true)} aria-label="重新检验" title="强制重新检验">↺</button>
                    )}
                  </div>
                </div>

                {checkSt.startsWith('error:') && (
                  <p className="thesisCheckError">{checkSt.replace('error:', '')}</p>
                )}

                {thesisItems.length > 0 ? (
                  <ul className="holdingReminderList thesisCheckedList">
                    {thesisItems.map((item, index) => {
                      const result = itemResults.find((r) => r.thesisId === item.id);
                      const badge = verdictLabel(result);
                      const isExpanded = expandedThesisItem[item.id];
                      const rowCls = badge
                        ? (badge.cls === 'thesisBadgeOk' ? 'holdingReminderRow thesisRowOk'
                          : badge.cls === 'thesisBadgeWarn' ? 'holdingReminderRow thesisRowWarn'
                          : badge.cls === 'thesisBadgeDanger' ? 'holdingReminderRow thesisRowDanger'
                          : 'holdingReminderRow')
                        : 'holdingReminderRow';
                      return (
                        <li key={item.id}>
                          <div className={rowCls}>
                            <span className="reminderBullet" aria-hidden="true" />
                            <input
                              value={item.text}
                              placeholder={`持仓逻辑 ${index + 1}`}
                              onChange={(event) => updateHoldingItem(holding, 'thesisItems', item.id, event.target.value)}
                              aria-label={`持仓逻辑 ${index + 1}`}
                            />
                            {badge && (
                              <button
                                className={`thesisBadge ${badge.cls}`}
                                onClick={() => setExpandedThesisItem((p) => ({ ...p, [item.id]: !p[item.id] }))}
                                aria-expanded={isExpanded}
                                aria-label={`查看分析：${badge.text}`}
                              >
                                {badge.text}
                              </button>
                            )}
                            {isChecking && !badge && <span className="thesisBadge thesisBadgePending">检验中</span>}
                            <button
                              className="reminderDelete"
                              onClick={() => removeHoldingItem(holding, 'thesisItems', item.id)}
                              aria-label={`删除持仓逻辑 ${index + 1}`}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>

                          {isExpanded && result && (
                            <div className="thesisDrawer">
                              {result.premises?.length > 0 && (
                                <div className="thesisDrawerBlock">
                                  <div className="thesisDrawerLabel">论据拆解</div>
                                  {result.premises.map((p, pi) => (
                                    <div key={pi} className={`thesisPremiseRow ${p.holds ? 'thesisPremiseOk' : 'thesisPremiseFail'}`}>
                                      <span className="thesisPremiseIcon" aria-hidden="true">{p.holds ? '✓' : '✗'}</span>
                                      <span className="thesisPremiseText">{p.claim}{p.note ? <em> — {p.note}</em> : null}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {result.analysis && (
                                <div className="thesisDrawerBlock">
                                  <div className="thesisDrawerLabel">AI 判断</div>
                                  <p className="thesisDrawerText">{result.analysis}</p>
                                  {result.changes && <p className="thesisDrawerChanges">{result.changes}</p>}
                                </div>
                              )}
                              {result.retrieval?.keywords?.length > 0 && (
                                <div className="thesisDrawerBlock thesisRetrieval">
                                  <span className="thesisDrawerLabel">Agent 检索</span>
                                  <span className="thesisRetrievalKeywords">{result.retrieval.keywords.join(' · ')}</span>
                                </div>
                              )}
                              {result.evidence?.length > 0 && (
                                <div className="thesisDrawerBlock">
                                  <div className="thesisDrawerLabel">证据</div>
                                  {result.evidence.map((ev, ei) => (
                                    <div key={ei} className="thesisEvidenceRow">
                                      <a
                                        href={`${apiBase}/api/sec/filings/${encodeURIComponent(ticker)}/${ev.accessionNumber}.pdf`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="thesisEvidenceLink"
                                      >
                                        {ev.accessionNumber}{ev.period ? ` · ${ev.period}` : ''}{ev.metric ? ` · ${ev.metric}` : ''}
                                      </a>
                                      {ev.quote && <blockquote className="thesisEvidenceQuote">{ev.quote}</blockquote>}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="holdingListEmpty">还没有持仓逻辑。</p>
                )}
                <button className="holdingAddItem" onClick={() => addHoldingItem(holding, 'thesisItems')}>
                  <Plus size={14} />
                  添加一条
                </button>
              </section>

              <section className="holdingListEditor riskListEditor" aria-labelledby={`risk-title-${holding.id}`}>
                <div className="holdingEditorHead">
                  <span id={`risk-title-${holding.id}`}>风险点</span>
                </div>
                {riskItems.length > 0 ? (
                  <ul className="holdingReminderList">
                    {riskItems.map((item, index) => (
                      <li className="holdingReminderRow" key={item.id}>
                        <span className="reminderBullet" aria-hidden="true" />
                        <input
                          value={item.text}
                          placeholder={`风险点 ${index + 1}`}
                          onChange={(event) => updateHoldingItem(holding, 'riskItems', item.id, event.target.value)}
                          aria-label={`风险点 ${index + 1}`}
                        />
                        <button
                          className="reminderDelete"
                          onClick={() => removeHoldingItem(holding, 'riskItems', item.id)}
                          aria-label={`删除风险点 ${index + 1}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="holdingListEmpty">还没有风险点。</p>
                )}
                <button className="holdingAddItem" onClick={() => addHoldingItem(holding, 'riskItems')}>
                  <Plus size={14} />
                  添加一条
                </button>
              </section>

              {(conflicts.length > 0 || coverage) && (
                <div className="thesisConflictCallout">
                  {conflicts.map((c, ci) => (
                    <div key={ci} className="thesisConflictRow">
                      <span className="thesisConflictIcon" aria-hidden="true">⚡</span>
                      <span>{c.detail}</span>
                    </div>
                  ))}
                  {coverage && (
                    <div className="thesisCoverageRow">
                      已检索 {coverage.filingsUsed} / {coverage.filingsExpected} 份 filing
                    </div>
                  )}
                </div>
              )}
            </div>
        ) : holdingTab === 'entry' ? (
          <div className="holdingThesisWorkspace">
            <section className="entryPlan" aria-labelledby={`entry-plan-title-${holding.id}`}>
              <div className="holdingEditorHead">
                <span id={`entry-plan-title-${holding.id}`}>建仓计划</span>
                <em>预计 {plannedShares.toLocaleString('en-US', { maximumFractionDigits: 4 })} 股</em>
              </div>
              <div className="entryPlanGrid">
                <label>
                  <span>建仓批次</span>
                  <input
                    type="number"
                    min="1"
                    max="20"
                    step="1"
                    value={entryPlan.batches}
                    onChange={(event) => updateEntryPlan(holding, 'batches', event.target.value)}
                  />
                </label>
                <label>
                  <span>每批股数</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={entryPlan.sharesPerBatch}
                    onChange={(event) => updateEntryPlan(holding, 'sharesPerBatch', event.target.value)}
                  />
                </label>
                <label>
                  <span>目标仓位</span>
                  <div className="entryPlanSuffix">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={entryPlan.targetWeight}
                      onChange={(event) => updateEntryPlan(holding, 'targetWeight', event.target.value)}
                    />
                    <em>%</em>
                  </div>
                </label>
              </div>
            </section>
          </div>
        ) : holdingTab === 'fundamentals' ? (
          <div className="secTabPane">
            {ticker && (
              <SecReportPanel
                ticker={ticker}
                report={secReports[ticker]}
                status={secReportStatus[ticker]}
                onRefresh={() => loadSecReport(ticker, true)}
              />
            )}
          </div>
        ) : (
          <div className="secTabPane">
            <div className="secFilingPanel">
              {filingStatus === 'loading' && <p className="secFilingState">正在获取 10-K / 10-Q / 8-K...</p>}
              {filingStatus === 'error' && <p className="secFilingState">自动获取失败，可先用 SEC 搜索打开。</p>}
              {filingStatus !== 'loading' && filingPayload?.filings?.length === 0 && <p className="secFilingState">未找到 10-K / 10-Q / 8-K。</p>}
              {filingPayload?.filings?.length > 0 && (
                <div className="secFilingList">
                  {filingPayload.filings.map((filing) => {
                    const summaryKey = `${ticker}:${filing.accessionNumber}`;
                    const summary = filingSummaries[summaryKey];
                    const summaryStatus = filingSummaryStatus[summaryKey];
                    return (
                      <article className="secFilingItem" key={filing.accessionNumber}>
                        <div className="secFilingRow">
                          <div>
                            <strong>{filing.form}</strong>
                            <span>{filing.filingDate}{filing.reportDate ? ` / ${filing.reportDate}` : ''}</span>
                          </div>
                          <a
                            href={`${apiBase}${filing.pdfUrl}`}
                            download={`${ticker}-${filing.form}-${filing.filingDate}.pdf`}
                          >
                            下载 PDF
                          </a>
                        </div>
                        {summaryStatus === 'loading' && (
                          <div className="secFilingSummaryLoading" aria-label="AI 正在生成文件摘要">
                            <span />
                            <span />
                          </div>
                        )}
                        {summary && (
                          <div className="secFilingSummary">
                            <div className="secFilingSummaryHead">
                              <span>AI 要点</span>
                              <em>{summary.source === 'deepseek' ? 'Filing 分析' : '自动摘要'}</em>
                            </div>
                            {summary.headline && <strong>{summary.headline}</strong>}
                            {summary.bullets?.length > 0 && (
                              <ul>
                                {summary.bullets.map((item, index) => (
                                  <li key={`${item.label}-${index}`}>
                                    <span>{item.label}</span>
                                    <p>{item.detail}</p>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {summary.analystView && <p className="secAnalystView">{summary.analystView}</p>}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="secStrip">
              <button className="addAssetButton" onClick={() => {
                loadSecFilings(holding.symbol, true);
                loadSecReport(holding.symbol, true);
              }}>
                <FileDown size={16} />
                {filingStatus === 'loading' ? '获取中' : '刷新 SEC'}
              </button>
              <a href={secFilingsUrl(holding.symbol)} target="_blank" rel="noreferrer">
                <FileDown size={16} />
                搜索公司
              </a>
              <a href={secCompanyUrl(holding.symbol)} target="_blank" rel="noreferrer">
                <ExternalLink size={16} />
                SEC 档案
              </a>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
