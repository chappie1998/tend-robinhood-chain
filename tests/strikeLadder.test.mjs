import assert from 'node:assert/strict';
import test from 'node:test';
import { binaryTerms, DEFAULT_TILE, PAYOUT_TIERS, isTileIndex, strikeLadder } from '../quote-service/strikeLadder.ts';
import { MAKER_EDGE_BPS } from '../quote-service/pricing.ts';
import { formatPriceForDisplay } from '../quote-service/formatPrice.ts';
import { formatUsdPrice } from '../web/src/lib/format.ts';

const YEAR = 365 * 24 * 60 * 60;
const base = { spot: 75_000, volAnnual: 0.35, makerEdgeBps: MAKER_EDGE_BPS, priceScale: 100_000_000 };

test('fixed binary tiers preserve exact 1.5x, 2x, and 3x payouts', () => {
  assert.deepEqual(PAYOUT_TIERS.map((tier) => tier.multiple), [1.5, 2, 3]);
  assert.deepEqual(binaryTerms(101n, 10_000n, 0), { premium: 100n, maxPayout: 150n, clamped: true });
  assert.deepEqual(binaryTerms(101n, 10_000n, 1), { premium: 101n, maxPayout: 202n, clamped: false });
  assert.deepEqual(binaryTerms(101n, 10_000n, 2), { premium: 101n, maxPayout: 303n, clamped: false });
});

test('capacity clamps premium while retaining the exact selected ratio', () => {
  assert.deepEqual(binaryTerms(101n, 151n, 0), { premium: 100n, maxPayout: 150n, clamped: true });
  assert.deepEqual(binaryTerms(101n, 401n, 1), { premium: 101n, maxPayout: 202n, clamped: false });
  assert.deepEqual(binaryTerms(101n, 302n, 2), { premium: 100n, maxPayout: 300n, clamped: true });
  assert.throws(() => binaryTerms(1n, 1n, 0), /cannot support/);
});

for (const direction of ['up', 'down']) {
  test(`${direction} strikes are conservative across supported tenors`, () => {
    for (const minutes of [15, 60, 720, 0.5]) {
      const tiles = strikeLadder({ ...base, direction, timeYears: (minutes * 60) / YEAR });
      assert.equal(tiles.length, 3);
      for (const [index, tile] of tiles.entries()) {
        assert.equal(tile.index, index);
        assert.equal(tile.multiple, PAYOUT_TIERS[index].multiple);
        assert.ok(tile.strikeRaw > 0n, `${minutes}m tier ${index} has positive raw strike`);
        assert.ok(tile.probabilityItm > 0 && tile.probabilityItm <= tile.targetProbability + 1e-12);
        assert.equal(tile.probabilityProfit, tile.probabilityItm);
        assert.ok(tile.makerEdgeBps >= MAKER_EDGE_BPS - 1e-7);
        assert.equal(Number(tile.strikeRaw) / base.priceScale, tile.strike);
      }
    }
  });
}

test('invalid binary inputs fail closed', () => {
  assert.throws(() => strikeLadder({ ...base, direction: 'up', spot: 0, timeYears: 1 / YEAR }), /positive spot/);
  assert.throws(() => strikeLadder({ ...base, direction: 'up', volAnnual: 0, timeYears: 1 / YEAR }), /volatility/);
  assert.throws(() => strikeLadder({ ...base, direction: 'up', timeYears: 0 }), /time to expiry/);
  assert.ok(isTileIndex(0) && isTileIndex(1) && isTileIndex(2) && isTileIndex(DEFAULT_TILE));
  assert.ok(!isTileIndex(3) && !isTileIndex('1'));
});

test('low-volatility near-expiry tiers stay distinct and near their target odds', () => {
  // Regression: a fixed $1 ETH tick rounded the 2x and 3x 90-second UP
  // strikes to $2501, changing their win chance from 43%/29% to ~0%.
  for (const direction of ['up', 'down']) {
    const tiles = strikeLadder({
      direction,
      spot: 2_500,
      volAnnual: 0.05,
      timeYears: 90 / YEAR,
      makerEdgeBps: MAKER_EDGE_BPS,
      priceScale: 100_000_000,
    });
    assert.notEqual(tiles[1].strikeRaw, tiles[2].strikeRaw, `${direction} 2x and 3x strikes must differ`);
    assert.notEqual(formatPriceForDisplay(tiles[1].strike), formatPriceForDisplay(tiles[2].strike), `${direction} service display must distinguish tiers`);
    assert.notEqual(formatUsdPrice(tiles[1].strike), formatUsdPrice(tiles[2].strike), `${direction} web display must distinguish tiers`);
    for (const tile of tiles) {
      assert.ok(tile.targetProbability - tile.probabilityItm < 0.01, `${direction} tier ${tile.index} rounding stays material`);
      assert.ok(tile.probabilityItm <= tile.targetProbability + 1e-12, `${direction} remains conservative`);
    }
  }
});
