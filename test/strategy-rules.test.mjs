import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveConditionsFromText } from '../src/strategyRules.mjs';

test('derives drawdown entry and exit conditions from strategy notes', () => {
  const conditions = deriveConditionsFromText('QQQ 回撤 25% 时买一点 TQQQ，回撤 35% 时继续加，恢复到前高附近退出。');

  assert.equal(conditions.length, 3);
  assert.deepEqual(
    conditions.map((condition) => ({
      triggerAsset: condition.triggerAsset,
      operator: condition.operator,
      value: condition.value,
      targetAsset: condition.targetAsset,
      targetWeight: condition.targetWeight,
      priority: condition.priority
    })),
    [
      { triggerAsset: 'QQQ', operator: '>=', value: 25, targetAsset: 'TQQQ', targetWeight: 10, priority: 1 },
      { triggerAsset: 'QQQ', operator: '>=', value: 35, targetAsset: 'TQQQ', targetWeight: 20, priority: 2 },
      { triggerAsset: 'QQQ', operator: '<=', value: 5, targetAsset: 'TQQQ', targetWeight: 0, priority: 99 }
    ]
  );
});
