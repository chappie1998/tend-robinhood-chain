// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

/// @title DeployableMockPyth
/// @notice A first-class, deployable subclass of Pyth's MockPyth so Hardhat
/// exposes a named artifact for it. MockPyth ships in the Pyth SDK
/// (node_modules) and is pulled in by the test suite, but Hardhat only makes
/// project contracts deployable by name — this thin forwarder gives the
/// Monad deploy script something to instantiate.
/// @dev Testnet demo only. Monad testnet's canonical Pyth receiver rejects
/// live Hermes updates (InvalidWormholeVaa, stale on-chain guardian set), so
/// the demo drives settlement through MockPyth with real Hermes-sourced
/// prices; only Wormhole signature verification is bypassed. Prototype —
/// unaudited.
contract DeployableMockPyth is MockPyth {
    constructor(uint256 validTimePeriod, uint256 singleUpdateFeeInWei)
        MockPyth(validTimePeriod, singleUpdateFeeInWei)
    {}
}
