import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTicker, parseCandles, productForFeed, fetchDemoCandles, fetchDemoSettlementPrice } from '../market-data/coinbase.ts';
test('exchange ticker keeps its actual timestamp and scales USD to contract units', () => {
  const value = parseTicker({price:'60000.12',time:new Date(1000000).toISOString()}, 1001);
  assert.equal(value.price,6000012000000n); assert.equal(value.publishTime,1000);
  assert.equal(value.source,'Coinbase Exchange');
});
test('reject stale, future, missing and non-positive exchange prices', () => {
  for (const raw of [{price:'1',time:new Date(1000000).toISOString()},{price:'0'},{price:'NaN'},null]) assert.throws(()=>parseTicker(raw,2000));
  assert.throws(()=>parseTicker({price:'1',time:new Date(3000000).toISOString()},2000));
});
test('normalizes reverse-ordered candles, deduplicates boundaries and filters window', () => {
  assert.deepEqual(parseCandles([[200,1,4,2,3],[100,1,3,2,2],[200,1,4,2,3],[300,1,3,2,2]],100,300).map(b=>b.time),[100,200]);
});
test('rejects invalid OHLC and unsupported markets', () => {
  assert.throws(()=>parseCandles([[100,4,1,2,3]],0,200));
  assert.throws(()=>productForFeed('../../accounts'));
  assert.equal(productForFeed('Crypto.ETH/USD'),'ETH-USD');
});
test('shared aligned history cache respects each caller’s exact bounds', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json([[0, 1, 4, 2, 3], [3600, 2, 5, 3, 4]]);
  });
  assert.equal((await fetchDemoCandles('Crypto.BTC/USD', '240', 0, 14400)).length, 1);
  assert.deepEqual(await fetchDemoCandles('Crypto.BTC/USD', '240', 1, 14400), []);
  assert.equal(calls, 1);
});
test('an unpublished expiry candle is retried and uses its actual minute open', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json(++calls === 1 ? [] : [[600, 2, 5, 3, 4]]));
  await assert.rejects(fetchDemoSettlementPrice('Crypto.ETH/USD', 600), /not published/);
  const price = await fetchDemoSettlementPrice('Crypto.ETH/USD', 600);
  assert.equal(price.price, 300000000n);
  assert.equal(price.publishTime, 600);
  assert.equal(calls, 2);
});
