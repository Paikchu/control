import React from 'react';

export function MarketSparkline({ values }) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const width = 72;
  const height = 30;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((value, index) => [
    (index / (values.length - 1)) * width,
    height - 2 - ((value - min) / span) * (height - 4)
  ]);
  const line = points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  return (
    <svg className="marketSparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon className="marketSparklineFill" points={`0,${height} ${line} ${width},${height}`} />
      <polyline className="marketSparklineLine" points={line} fill="none" />
    </svg>
  );
}
