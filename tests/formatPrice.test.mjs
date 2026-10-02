import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPriceForDisplay } from '../quote-service/formatPrice.ts';

test('prices above a dollar retain binary strike precision', () => {
  assert.equal(formatPriceForDisplay(76280), '76280.000');
  assert.equal(formatPriceForDisplay(2401.4), '2401.400');
  assert.equal(formatPriceForDisplay(1), '1.0000');
  assert.notEqual(formatPriceForDisplay(2500.123), formatPriceForDisplay(2500.124));
});

test('sub-dollar prices keep enough decimals to stay distinct', () => {
  // The bug this exists to prevent: MON trades near $0.023, and at two
  // decimals all three ladder rungs rendered as "0.02" — in the tile a trader
  // picks from AND in the signed quote's humanTerms.
  const rungs = [0.02283, 0.023, 0.02329].map(formatPriceForDisplay);
  assert.equal(new Set(rungs).size, 3, `rungs collapsed: ${rungs.join(', ')}`);
  assert.equal(rungs[0], '0.022830');
});

test('very small prices do not round to zero', () => {
  assert.notEqual(Number(formatPriceForDisplay(0.00012345)), 0);
  assert.notEqual(Number(formatPriceForDisplay(0.00000123)), 0);
});

test('decimals are capped at the on-chain price resolution', () => {
  // PRICE_SCALE is 1e8, so anything past 8 decimals is precision the chain
  // cannot represent.
  for (const v of [0.000000001, 0.00000000012]) {
    const decimals = (formatPriceForDisplay(v).split('.')[1] ?? '').length;
    assert.ok(decimals <= 8, `${v} formatted with ${decimals} decimals`);
  }
});

test('non-finite input is refused, never rendered as a number', () => {
  for (const v of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(formatPriceForDisplay(v), '—');
  }
});
