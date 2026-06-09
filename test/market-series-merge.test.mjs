import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePriceData } from '../src/marketSeries.mjs';

test('uses fetched market data only on dates shared by every fetched ticker', () => {
  const baseRows = [
    { date: '2010-02-10', QQQ: 100, TQQQ: 1000 },
    { date: '2010-02-11', QQQ: 101, TQQQ: 1001 },
    { date: '2010-02-15', QQQ: 102, TQQQ: 1002 },
    { date: '2010-02-16', QQQ: 103, TQQQ: 1003 }
  ];
  const fetchedSeries = {
    QQQ: [
      { date: '2010-02-10', close: 37.33 },
      { date: '2010-02-11', close: 37.9 },
      { date: '2010-02-16', close: 38.46 }
    ],
    TQQQ: [
      { date: '2010-02-11', close: 0.206 },
      { date: '2010-02-16', close: 0.214 }
    ]
  };

  assert.deepEqual(mergePriceData(baseRows, fetchedSeries), [
    { date: '2010-02-11', QQQ: 37.9, TQQQ: 0.206 },
    { date: '2010-02-16', QQQ: 38.46, TQQQ: 0.214 }
  ]);
});
