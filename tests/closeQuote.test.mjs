import assert from 'node:assert/strict';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { bidFromMark, CLOSE_SPREAD_BPS, deriveAndSignCloseQuote } from '../quote-service/closeQuote.ts';

const VAULT = '0x00000000000000000000000000000000000000v1'.replace('v1', '01');
const FACTORY = '0x00000000000000000000000000000000000000f1'.replace('f1', '02');
const HOLDER = '0x9660093CE5a6Cfe346d1fEF2bdC12e5E77C2a2Cc';
const OTHER = '0x1111111111111111111111111111111111111111';
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

/** An open position; overrides let each case bend exactly one fact. */
function position(overrides = {}) {
  const base = {
    buyer: HOLDER,
    seriesId: '0x'.padEnd(66, '1'),
    direction: 0,
    strike: 7_500_000_000_000n,
    width: 37_500_000_000n,
    premium: 10_000_000n,
    maxPayout: 250_000_000n,
    feeBps: 0,
    settled: false,
    closed: false,
    closeBid: 0n,
  };
  const p = { ...base, ...overrides };
  return [p.buyer, p.seriesId, p.direction, p.strike, p.width, p.premium, p.maxPayout, p.feeBps, p.settled, p.closed, p.closeBid];
}

/** Stub client: answers positions()/getSeries() only, so these cases never reach the network. */
function stubClient({ pos = position(), expiry } = {}) {
  const seriesExpiry = expiry ?? BigInt(Math.floor(Date.now() / 1000) + 3600);
  return {
    async readContract({ functionName }) {
      if (functionName === 'positions') return pos;
      if (functionName === 'getSeries') {
        return {
          creator: OTHER,
          pythFeedId: '0x'.padEnd(66, '2'),
          settlementToken: OTHER,
          expiry: seriesExpiry,
          observationWindow: 60,
          settlementGrace: 3600,
          maxConfidenceBps: 2000,
          symbol: '0x'.padEnd(66, '3'),
          enabled: true,
        };
      }
      throw new Error(`unexpected read: ${functionName}`);
    },
  };
}

const call = (publicClient, body) =>
  deriveAndSignCloseQuote({ publicClient, account, factory: FACTORY, vault: VAULT, body });

async function rejects(promise, status, messageMatch) {
  try {
    await promise;
    assert.fail('expected a rejection');
  } catch (err) {
    assert.equal(err.status, status, `status (got ${err.status}: ${err.message})`);
    if (messageMatch) assert.match(err.message, messageMatch);
    return err;
  }
}

test('bidFromMark takes the spread and rounds down', () => {
  // 100.000000 mUSDC at a 5% spread = 95.000000, exactly.
  assert.equal(bidFromMark(100_000_000n, 250_000_000n), 95_000_000n);
  assert.equal(CLOSE_SPREAD_BPS, 500);
  // Rounding always favours the pool: 1 unit at 5% is 0.95 -> 0.
  assert.equal(bidFromMark(1n, 250_000_000n), 0n);
  assert.equal(bidFromMark(0n, 250_000_000n), 0n);
  assert.equal(bidFromMark(-5n, 250_000_000n), 0n);
});

test('bidFromMark never exceeds the escrow the contract holds', () => {
  // Even an absurd mark cannot produce a bid above maxPayout — the contract
  // would revert BidExceedsEscrow, and a signed quote must never do that.
  assert.equal(bidFromMark(10_000_000_000n, 250_000_000n), 250_000_000n);
});

test('a position that does not exist is a 404', async () => {
  const client = stubClient({ pos: position({ buyer: '0x0000000000000000000000000000000000000000' }) });
  await rejects(call(client, { positionId: '7', seller: HOLDER }), 404, /does not exist/);
});

test('an already-settled or already-closed position cannot be sold back', async () => {
  const settled = stubClient({ pos: position({ settled: true }) });
  await rejects(call(settled, { positionId: '1', seller: HOLDER }), 409, /settled or refunded/);

  const closed = stubClient({ pos: position({ settled: true, closed: true }) });
  await rejects(call(closed, { positionId: '1', seller: HOLDER }), 409, /already closed/);
});

test("another wallet cannot sell someone else's position", async () => {
  const client = stubClient();
  await rejects(call(client, { positionId: '1', seller: OTHER }), 403, /belongs to another wallet/);
});

test('an expired series settles rather than trades', async () => {
  const past = BigInt(Math.floor(Date.now() / 1000) - 1);
  await rejects(call(stubClient({ expiry: past }), { positionId: '1', seller: HOLDER }), 409, /has expired/);

  // Inside the quote's own TTL of expiry there is no window left to sign into.
  const soon = BigInt(Math.floor(Date.now() / 1000) + 5);
  await rejects(call(stubClient({ expiry: soon }), { positionId: '1', seller: HOLDER }), 409, /Too close to expiry/);
});

test('malformed input is rejected before any chain read', async () => {
  const client = { async readContract() { throw new Error('must not be called'); } };
  await rejects(call(client, { positionId: '0', seller: HOLDER }), 400, /positive integer/);
  await rejects(call(client, { positionId: 'abc', seller: HOLDER }), 400, /positive integer/);
  await rejects(call(client, { positionId: '1', seller: 'not-an-address' }), 400, /address/);
});
