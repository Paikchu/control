import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEntryPlan, normalizeHoldingItems } from '../src/holdingNotes.mjs';

test('migrates legacy holding text into editable list items', () => {
  assert.deepEqual(normalizeHoldingItems(undefined, '核心科技 Beta。', 'thesis'), [
    { id: 'thesis-0', text: '核心科技 Beta。' }
  ]);
  assert.deepEqual(normalizeHoldingItems([{ id: 'risk-1', text: '' }], '旧风险', 'risk'), [
    { id: 'risk-1', text: '' }
  ]);
});

test('normalizes entry plan defaults and numeric values', () => {
  assert.deepEqual(normalizeEntryPlan(), {
    batches: 3,
    sharesPerBatch: 0,
    targetWeight: 0
  });
  assert.deepEqual(normalizeEntryPlan({ batches: '4', sharesPerBatch: '25', targetWeight: '12.5' }), {
    batches: 4,
    sharesPerBatch: 25,
    targetWeight: 12.5
  });
});
