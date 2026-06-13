// 期权链结构指标 —— 纯函数，便于 node --test 直接验证。
// 输入是「归一化后的合约行」数组，每行形如：
//   { strike, right: 'C'|'P', openInterest, volume, gamma, ... }
// 下游 optionsService 负责从 IBKR snapshot 拼出这些行。

const CONTRACT_MULTIPLIER = 100;

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function isCall(contract) {
  return String(contract?.right || '').toUpperCase().startsWith('C');
}

// Put/Call Ratio —— 量(情绪)与未平仓量(结构)各算一份。
// 分母为 0 时返回 null，避免抛出 Infinity 误导前端。
export function putCallRatios(contracts) {
  let callVol = 0;
  let putVol = 0;
  let callOI = 0;
  let putOI = 0;
  for (const contract of contracts) {
    const vol = toNumber(contract.volume);
    const oi = toNumber(contract.openInterest);
    if (isCall(contract)) {
      callVol += vol;
      callOI += oi;
    } else {
      putVol += vol;
      putOI += oi;
    }
  }
  return {
    pcrVolume: callVol > 0 ? putVol / callVol : null,
    pcrOI: callOI > 0 ? putOI / callOI : null,
    callVolume: callVol,
    putVolume: putVol,
    callOpenInterest: callOI,
    putOpenInterest: putOI
  };
}

// 单合约 GEX，单位 $ / 1% 标的变动。
// 朴素做市商假设：long call / short put（call 计正，put 计负）。
// gamma × OI × 100 × spot² × 0.01。
function contractGex(contract, spot) {
  const gamma = toNumber(contract.gamma);
  const oi = toNumber(contract.openInterest);
  if (!gamma || !oi || !spot) return 0;
  const sign = isCall(contract) ? 1 : -1;
  return sign * gamma * oi * CONTRACT_MULTIPLIER * spot * spot * 0.01;
}

// 按行权价聚合 call/put OI 与净 GEX，行权价升序。
export function aggregateByStrike(contracts, spot) {
  const map = new Map();
  for (const contract of contracts) {
    const strike = toNumber(contract.strike);
    if (!strike) continue;
    if (!map.has(strike)) {
      map.set(strike, { strike, callOI: 0, putOI: 0, callVolume: 0, putVolume: 0, gex: 0 });
    }
    const bucket = map.get(strike);
    const oi = toNumber(contract.openInterest);
    const vol = toNumber(contract.volume);
    if (isCall(contract)) {
      bucket.callOI += oi;
      bucket.callVolume += vol;
    } else {
      bucket.putOI += oi;
      bucket.putVolume += vol;
    }
    bucket.gex += contractGex(contract, spot);
  }
  return [...map.values()].sort((a, b) => a.strike - b.strike);
}

export function netGamma(contracts, spot) {
  let total = 0;
  for (const contract of contracts) total += contractGex(contract, spot);
  return total;
}

// Put/Call Wall：OI 最大的 call / put 行权价。
// call wall 视为上方阻力，put wall 视为下方支撑。
export function putCallWalls(byStrike) {
  let callWall = null;
  let putWall = null;
  let maxCallOI = 0;
  let maxPutOI = 0;
  for (const row of byStrike) {
    if (row.callOI > maxCallOI) {
      maxCallOI = row.callOI;
      callWall = row.strike;
    }
    if (row.putOI > maxPutOI) {
      maxPutOI = row.putOI;
      putWall = row.strike;
    }
  }
  return { callWall, putWall, callWallOI: maxCallOI, putWallOI: maxPutOI };
}

// Gamma flip / zero-gamma：沿行权价累计 GEX，找累计值由负转正的价位。
// 用线性插值估翻转点；始终为正或始终为负则返回 null。
export function gammaFlip(byStrike) {
  let cumulative = 0;
  let prevStrike = null;
  let prevCumulative = 0;
  for (const row of byStrike) {
    const next = cumulative + row.gex;
    if (prevStrike !== null && ((prevCumulative <= 0 && next > 0) || (prevCumulative >= 0 && next < 0))) {
      const span = next - prevCumulative;
      const ratio = span === 0 ? 0 : -prevCumulative / span;
      return prevStrike + ratio * (row.strike - prevStrike);
    }
    prevStrike = row.strike;
    prevCumulative = next;
    cumulative = next;
  }
  return null;
}

function biasFromMetrics({ netGamma: gex, pcrOI }) {
  // 启发式：负 gamma + 高 PCR 偏空；正 gamma + 低 PCR 偏多。仅作 header 兜底色，
  // 真正的研判文字来自 DeepSeek。
  let score = 0;
  if (Number.isFinite(gex)) score += gex >= 0 ? 1 : -1;
  if (Number.isFinite(pcrOI)) {
    if (pcrOI > 1.1) score -= 1;
    else if (pcrOI < 0.7) score += 1;
  }
  if (score >= 1) return 'bullish';
  if (score <= -1) return 'bearish';
  return 'neutral';
}

// 单个标的的完整指标包。contracts 已按 ±范围/到期裁剪。
export function computeOptionMetrics({ symbol, spot, contracts, asOf, dataDelayMin = null }) {
  const ratios = putCallRatios(contracts);
  const byStrike = aggregateByStrike(contracts, spot);
  const gex = netGamma(contracts, spot);
  const walls = putCallWalls(byStrike);
  const flip = gammaFlip(byStrike);
  const metrics = {
    symbol,
    spot,
    asOf,
    dataDelayMin,
    contractCount: contracts.length,
    pcrVolume: ratios.pcrVolume,
    pcrOI: ratios.pcrOI,
    netGamma: gex,
    gammaFlip: flip,
    callWall: walls.callWall,
    putWall: walls.putWall,
    callWallOI: walls.callWallOI,
    putWallOI: walls.putWallOI,
    volumes: {
      callVolume: ratios.callVolume,
      putVolume: ratios.putVolume,
      callOpenInterest: ratios.callOpenInterest,
      putOpenInterest: ratios.putOpenInterest
    },
    byStrike
  };
  metrics.bias = biasFromMetrics(metrics);
  return metrics;
}

// 给 DeepSeek 的精简载荷：去掉远离现价的 byStrike 噪声，只留 wall 附近若干档。
export function compactMetricsForModel(metrics, { strikeWindow = 12 } = {}) {
  if (!metrics) return null;
  const sorted = [...(metrics.byStrike || [])];
  // 以最接近现价的行权价为中心，取前后各 strikeWindow 档。
  let centerIndex = 0;
  let bestDist = Infinity;
  sorted.forEach((row, index) => {
    const dist = Math.abs(row.strike - metrics.spot);
    if (dist < bestDist) {
      bestDist = dist;
      centerIndex = index;
    }
  });
  const start = Math.max(0, centerIndex - strikeWindow);
  const end = Math.min(sorted.length, centerIndex + strikeWindow + 1);
  return {
    symbol: metrics.symbol,
    spot: round(metrics.spot, 2),
    pcrVolume: round(metrics.pcrVolume, 3),
    pcrOI: round(metrics.pcrOI, 3),
    netGamma: round(metrics.netGamma, 0),
    gammaFlip: round(metrics.gammaFlip, 2),
    callWall: metrics.callWall,
    putWall: metrics.putWall,
    nearStrikes: sorted.slice(start, end).map((row) => ({
      strike: row.strike,
      callOI: Math.round(row.callOI),
      putOI: Math.round(row.putOI),
      gex: round(row.gex, 0)
    }))
  };
}

function round(value, digits) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
