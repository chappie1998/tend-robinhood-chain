import assert from 'node:assert/strict';
import test from 'node:test';
import markHandler, { calculateMarkValue } from '../api/mark.ts';
import { fairValue, probabilityItm, spreadUnitValue } from '../quote-service/pricing.ts';
import { formatExactStrike } from '../web/src/lib/format.ts';
import { computePayoffSummary, computePnlAtPrice, PRICE_SCALE } from '../web/src/lib/payoff.ts';

const quote = (direction) => ({
  nonce: 1n,
  direction,
  strike: 100n * BigInt(PRICE_SCALE),
  width: 1n,
  premium: 10_000_000n,
  maxPayout: 20_000_000n,
  quoteExpiry: 1n,
  seriesId: '0x'.padEnd(66, '1'),
  buyer: '0x1111111111111111111111111111111111111111',
});

test('one-tick quotes render strict expiry-only binary payoff', () => {
  const up = quote(0);
  assert.equal(computePnlAtPrice(up, 99.99999999), -10_000_000);
  assert.equal(computePnlAtPrice(up, 100), -10_000_000, 'UP tie loses');
  assert.equal(computePnlAtPrice(up, 100.000000004), -10_000_000, 'sub-tick UP change rounds to a tie');
  assert.equal(computePnlAtPrice(up, 100.00000001), 10_000_000, 'UP strict win pays cap');
  const down = quote(1);
  assert.equal(computePnlAtPrice(down, 100.00000001), -10_000_000);
  assert.equal(computePnlAtPrice(down, 100), -10_000_000, 'DOWN tie loses');
  assert.equal(computePnlAtPrice(down, 99.99999999), 10_000_000, 'DOWN strict win pays cap');
  assert.equal(computePayoffSummary(up).isBinary, true);
});

test('binary marks use probability times max payout while legacy widths retain spread value', () => {
  const params = { direction: 'up', spot: 100, strike: 101, maxPayout: 20, volAnnual: 0.5, timeYears: 1 / 365 };
  const binary = calculateMarkValue({ ...params, widthRaw: 1n });
  assert.equal(binary, params.maxPayout * probabilityItm('up', params.spot, params.strike, params.volAnnual, params.timeYears));

  const widthRaw = 2_000_000n;
  const width = Number(widthRaw) / PRICE_SCALE;
  const legacy = calculateMarkValue({ ...params, widthRaw });
  const expectedLegacy = fairValue(params.maxPayout, width, spreadUnitValue({ ...params, width }));
  assert.equal(legacy, expectedLegacy);
  assert.ok(Number.isNaN(calculateMarkValue({ ...params, widthRaw: 1n, timeYears: 0 })), 'post-expiry current spot is not a settlement mark');
});

test('strict winning threshold shows every signed raw price digit', () => {
  const signedStrike = 7_504_605_385_500n;
  assert.equal(formatExactStrike(signedStrike), '75,046.053855');
  assert.equal(formatExactStrike(Number(signedStrike) / PRICE_SCALE), '75,046.053855');
  assert.notEqual(formatExactStrike(signedStrike), '75,046.05');
});

test('expired unsettled position gets no current-spot mark from the endpoint', async () => {
  const request = { method: 'POST', body: { positions: [{
    feedId: 'unavailable-feed', direction: 'up', spot: 101, strike: '10000000000',
    width: '1', maxPayout: '20000000', premium: '10000000', expiry: 1,
  }] } };
  let responseBody = '';
  const response = {
    statusCode: 0,
    setHeader() {},
    end(body) { responseBody = body; },
  };
  await markHandler(request, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(responseBody), { marks: [{ value: null, pnl: null }] });
});
