// Behavioral tests for the deployment-target guards (config/deployment-target.ts).
//
// These guards are the only thing standing between a demo-shaped config and a
// mainnet deployment holding real USDC, so they are tested by calling them
// with real config objects rather than by inspecting their source.
//
// The failure they exist to prevent is specific and was live in this repo: a
// production target could leave `owner`, `emergencyAdmin`, `manager` and
// `feeRecipient` as the deployer sentinel, pass validation, and then have
// scripts/deploy.ts substitute the single CI-held deploy key for every one of
// them. Each `assert.throws` below pins one half of that hole shut.
import assert from "node:assert/strict";
import test from "node:test";

const { assertDeploymentTarget, assertDeployerNotPrivileged, DEPLOYER_SENTINEL } = await import(
  new URL("../config/deployment-target.ts", import.meta.url)
);

const OWNER = "0x1111111111111111111111111111111111111111";
const EMERGENCY = "0x2222222222222222222222222222222222222222";
const MANAGER = "0x3333333333333333333333333333333333333333";
const SIGNER = "0x4444444444444444444444444444444444444444";
const FEES = "0x5555555555555555555555555555555555555555";
const DEPLOYER = "0x6666666666666666666666666666666666666666";

const REAL_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const REAL_PYTH = "0x8250f4af4b972684f7b336503e2d6dfedeb1487a";

/** A fully-specified production target — the shape a real deploy must have. */
function productionTarget(overrides = {}) {
  return {
    network: "monadMainnet",
    chainId: 143,
    rpcUrl: "https://rpc.monad.xyz",
    explorer: "https://monadscan.com",
    deployMocks: false,
    settlementToken: REAL_USDC,
    pythAddress: REAL_PYTH,
    isProduction: true,
    pool: { maxUtilizationBps: 8_000, maxPositionBps: 2_500, feeBps: 0 },
    ...overrides,
    roles: {
      owner: OWNER,
      emergencyAdmin: EMERGENCY,
      manager: MANAGER,
      quoteAuthority: SIGNER,
      feeRecipient: FEES,
      ...(overrides.roles ?? {}),
    },
  };
}

test("a fully-specified production target passes validation", () => {
  assert.doesNotThrow(() => assertDeploymentTarget(productionTarget()));
});

test("the demo target still deploys with every role collapsed onto the deployer", () => {
  // isProduction: false is the deliberate escape hatch. If this ever throws,
  // the testnet demo stops deploying — the guards must not bleed into it.
  const demo = {
    network: "monadTestnet",
    chainId: 10143,
    rpcUrl: "https://testnet-rpc.monad.xyz",
    explorer: "",
    deployMocks: true,
    isProduction: false,
    pool: { maxUtilizationBps: 8_000, maxPositionBps: 2_500, feeBps: 0 },
    roles: {
      owner: DEPLOYER_SENTINEL,
      emergencyAdmin: DEPLOYER_SENTINEL,
      manager: DEPLOYER_SENTINEL,
      quoteAuthority: DEPLOYER_SENTINEL,
      feeRecipient: DEPLOYER_SENTINEL,
    },
  };
  assert.doesNotThrow(() => assertDeploymentTarget(demo));
  assert.doesNotThrow(() => assertDeployerNotPrivileged(demo, DEPLOYER));
});

// The regression this whole change exists for: before it, ONLY quoteAuthority
// was checked against the sentinel, so this exact config passed validation and
// then handed owner + emergencyAdmin + manager + feeRecipient to the deploy key.
test("a production target with every role but quoteAuthority left as the sentinel is REJECTED", () => {
  const dangerous = productionTarget({
    roles: {
      owner: DEPLOYER_SENTINEL,
      emergencyAdmin: DEPLOYER_SENTINEL,
      manager: DEPLOYER_SENTINEL,
      quoteAuthority: SIGNER,
      feeRecipient: DEPLOYER_SENTINEL,
    },
  });
  assert.throws(() => assertDeploymentTarget(dangerous), /sentinel/i);
});

for (const role of ["owner", "emergencyAdmin", "manager", "quoteAuthority", "feeRecipient"]) {
  test(`production rejects a sentinel ${role}, and names it in the error`, () => {
    const t = productionTarget({ roles: { [role]: DEPLOYER_SENTINEL } });
    assert.throws(
      () => assertDeploymentTarget(t),
      (err) => {
        assert.match(err.message, new RegExp(role, "i"), `error should name the offending role (${role})`);
        assert.match(err.message, /sentinel/i);
        return true;
      },
    );
  });
}

test("quoteAuthority may not equal manager or owner in production", () => {
  assert.throws(() => assertDeploymentTarget(productionTarget({ roles: { quoteAuthority: MANAGER } })), /manager/i);
  assert.throws(() => assertDeploymentTarget(productionTarget({ roles: { quoteAuthority: OWNER } })), /owner/i);
});

test("deployMocks=false still requires a real settlement token and Pyth receiver", () => {
  assert.throws(() => assertDeploymentTarget(productionTarget({ settlementToken: undefined })), /settlementToken/);
  assert.throws(() => assertDeploymentTarget(productionTarget({ pythAddress: undefined })), /pythAddress/);
});

// assertDeployerNotPrivileged closes the gap config comparison cannot see: two
// distinct config addresses can still resolve to the same private key when an
// operator points two env vars at one key (which .env.example documents for
// the demo). Only the live signer address reveals that.
test("a production deploy is refused when the connected deployer IS a privileged role", () => {
  for (const role of ["quoteAuthority", "owner", "emergencyAdmin", "manager"]) {
    const t = productionTarget({ roles: { [role]: DEPLOYER } });
    assert.throws(
      () => assertDeployerNotPrivileged(t, DEPLOYER),
      new RegExp(role, "i"),
      `deployer == ${role} must be refused`,
    );
  }
});

test("the check is case-insensitive on address comparison", () => {
  const t = productionTarget({ roles: { quoteAuthority: DEPLOYER.toUpperCase().replace("0X", "0x") } });
  assert.throws(() => assertDeployerNotPrivileged(t, DEPLOYER.toLowerCase()), /quoteAuthority/i);
});

test("an unprivileged deployer passes", () => {
  assert.doesNotThrow(() => assertDeployerNotPrivileged(productionTarget(), DEPLOYER));
});

test("production cannot deploy mock assets or oracles", () => {
  assert.throws(() => assertDeploymentTarget(productionTarget({ deployMocks: true })), /mock/i);
});

test("addresses, chain ID and integer risk limits are validated before deployment", () => {
  for (const field of ["settlementToken", "pythAddress"]) {
    assert.throws(() => assertDeploymentTarget(productionTarget({ [field]: "0x123" })), new RegExp(field));
  }
  assert.throws(() => assertDeploymentTarget(productionTarget({ roles: { manager: "not-an-address" } })), /manager/);
  for (const chainId of [0, -1, NaN, 1.5]) {
    assert.throws(() => assertDeploymentTarget(productionTarget({ chainId })), /chainId/);
  }
  for (const field of ["maxUtilizationBps", "maxPositionBps", "feeBps"]) {
    for (const value of [NaN, Infinity, 0.5]) {
      const target = productionTarget();
      target.pool[field] = value;
      assert.throws(() => assertDeploymentTarget(target), new RegExp(field));
    }
  }
});

test("production emergency authority is isolated from routine and signing roles", () => {
  for (const address of [OWNER, MANAGER, SIGNER]) {
    assert.throws(() => assertDeploymentTarget(productionTarget({ roles: { emergencyAdmin: address } })), /emergencyAdmin/);
  }
});
