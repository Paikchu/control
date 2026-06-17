import React from 'react';
import { ShieldAlert } from 'lucide-react';

function trustLabel(score) {
  if (!Number.isFinite(score)) return null;
  if (score >= 75) return { text: '可信度高', cls: 'thesisBadgeOk' };
  if (score >= 50) return { text: '可信度中等', cls: 'thesisBadgeNeutral' };
  return { text: '可信度偏低', cls: 'thesisBadgeWarn' };
}

function ExecutiveCard({ exec }) {
  const trust = trustLabel(exec.overallAssessment?.trustScore);
  return (
    <article className={`mgmtExecCard ${exec.status === 'departed' ? 'mgmtExecCardDeparted' : ''}`.trim()}>
      <div className="mgmtExecHead">
        <div>
          <strong>{exec.name}</strong>
          <span>{exec.role}</span>
        </div>
        <div className="mgmtExecHeadRight">
          {exec.status === 'departed' && <span className="thesisBadge thesisBadgeNeutral">已离任{exec.tenureEnd ? ` · ${exec.tenureEnd}` : ''}</span>}
          {trust && <span className={`thesisBadge ${trust.cls}`}>{trust.text}</span>}
        </div>
      </div>

      {exec.overallAssessment?.summary && <p className="mgmtExecSummary">{exec.overallAssessment.summary}</p>}

      {exec.achievements?.length > 0 && (
        <div className="mgmtExecSection">
          <span className="mgmtExecSectionLabel mgmtExecSectionLabelGood">过往事迹</span>
          <ul>
            {exec.achievements.map((item, index) => (
              <li key={`achievement-${index}`}>
                <p>{item.text}</p>
                {item.source?.url && (
                  <a href={item.source.url} target="_blank" rel="noreferrer">{item.source.title || '来源'}</a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {exec.background?.length > 0 && (
        <div className="mgmtExecSection">
          <span className="mgmtExecSectionLabel">履历背景</span>
          <ul>
            {exec.background.map((item, index) => (
              <li key={`background-${index}`}>
                <p>{item.text}</p>
                {item.source?.url && (
                  <a href={item.source.url} target="_blank" rel="noreferrer">{item.source.title || '来源'}</a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {exec.redFlags?.length > 0 && (
        <div className="mgmtExecSection mgmtExecSectionRisk">
          <span className="mgmtExecSectionLabel mgmtExecSectionLabelRisk">
            <ShieldAlert size={13} /> 劣迹 / 风险信号
          </span>
          <ul>
            {exec.redFlags.map((item, index) => (
              <li key={`redflag-${index}`}>
                <p>
                  {item.severity && <span className={`thesisBadge ${item.severity === 'high' ? 'thesisBadgeDanger' : 'thesisBadgeWarn'}`}>{item.severity}</span>}
                  {item.text}
                </p>
                {item.source?.url && (
                  <a href={item.source.url} target="_blank" rel="noreferrer">{item.source.title || '来源'}</a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

// 管理层分析页签：每个高管一张卡（履历/事迹/劣迹，均带来源），永久增量缓存 — 仅当
// 8-K Item 5.02 检测到人事变动时才会触发重新搜索。
export function ManagementPanel({ ticker, report, status, onRefresh }) {
  return (
    <section className="secAnalysisPanel" aria-label="管理层分析">
      <div className="secAnalysisHead">
        <div>
          <span>管理层分析</span>
          <strong>{ticker}</strong>
        </div>
        <button className="addAssetButton" onClick={onRefresh} disabled={status === 'loading'}>
          {status === 'loading' ? '分析中' : '强制重新分析'}
        </button>
      </div>

      {status === 'loading' && <p className="secFilingState">正在检测管理层变动并生成分析（首次较慢，命中缓存后接近即时）...</p>}
      {status === 'error' && <p className="secFilingState">管理层分析获取失败，可稍后重试。</p>}

      {report && (
        <>
          {report.active?.length === 0 && status !== 'loading' && (
            <p className="secFilingState">未能从 DEF 14A 中识别出管理层名册。</p>
          )}

          {report.active?.length > 0 && (
            <div className="mgmtExecGrid">
              {report.active.map((exec) => <ExecutiveCard exec={exec} key={exec.name} />)}
            </div>
          )}

          {report.departed?.length > 0 && (
            <details className="mgmtDepartedGroup">
              <summary>历史沿革 · 已离任 ({report.departed.length})</summary>
              <div className="mgmtExecGrid">
                {report.departed.map((exec) => <ExecutiveCard exec={exec} key={exec.name} />)}
              </div>
            </details>
          )}

          <p className="mgmtDisclaimer">{report.disclaimer}</p>
        </>
      )}
    </section>
  );
}
