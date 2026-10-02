import test from 'node:test';
import assert from 'node:assert/strict';
import { nearestFillableSeries } from '../web/src/lib/liveSeriesSelection.ts';
import { futureBucketsFor, pastBucketsFor } from '../web/src/lib/seriesSearchWindow.ts';
import { expiryForBucket, TENORS } from '../web/src/lib/seriesParams.ts';
const row = (expiry, extra = {}) => ({ expiry, lastTradeAt: expiry - 60n, fillable: true, ...extra });
test('15-minute selection takes the nearest expiry, not the last of a five-hour ladder', () => {
  const near = row(1900n); const far = row(19000n);
  assert.equal(nearestFillableSeries([far, near, row(2800n)], 1000n), near);
});
test('selection rolls forward after cutoff and ignores disabled or expired candidates', () => {
  const next = row(2800n);
  assert.equal(nearestFillableSeries([row(1900n), row(2000n, {fillable:false}), row(1800n), next], 1840n), next);
});
test('no eligible expiry stays unavailable instead of substituting a dead one', () => {
  assert.equal(nearestFillableSeries([row(1900n)], 1900n), undefined);
  assert.equal(nearestFillableSeries([], 1000n), undefined);
});
test('rolls forward before the 30-second signed quote stops fitting', () => {
  const next = row(2800n);
  assert.equal(nearestFillableSeries([row(1900n), next], 1820n), next);
});
test('candidate windows include every keeper rung across tenor grid phases', () => {
  for (const tenor of TENORS) {
    for (const now of [1789204020n, 1789257599n, 1789257600n]) {
      const base = ((now + tenor.leadSeconds - 1n) / tenor.leadSeconds) * tenor.leadSeconds;
      const candidates = new Set();
      for (let k = -futureBucketsFor(tenor); k <= pastBucketsFor(tenor); k++) candidates.add(expiryForBucket(now, k, tenor.leadSeconds));
      for (let rung = 1n; rung <= BigInt(tenor.ladderSize); rung++) assert.ok(candidates.has(base + rung * tenor.leadSeconds), `${tenor.id} rung ${rung}`);
    }
  }
});
