// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {TendSeriesFactory} from "./TendSeriesFactory.sol";
import {TendPoolVault} from "./TendPoolVault.sol";
import {MockERC20} from "./test/MockERC20.sol";

contract TendPoolVaultTest is Test {
    TendSeriesFactory internal factory;
    TendPoolVault internal vault;
    MockPyth internal pyth;
    MockERC20 internal token;

    uint256 internal constant QUOTE_AUTHORITY_PK = 0xA11CE;
    uint256 internal constant WRONG_SIGNER_PK = 0xBAD;
    address internal quoteAuthority;
    address internal lp = address(0x117);
    address internal buyer = address(0xB0B);
    address internal feeRecipient = address(0xFEE);
    address internal emergencyAdmin = address(0xE33);

    bytes32 internal feedId = bytes32(uint256(0xFEED));
    bytes32 internal seriesId;
    uint64 internal expiry;
    uint64 internal lastTradeAt;

    uint32 internal constant OBS_WINDOW = 60;
    uint32 internal constant GRACE = 3_600;
    uint16 internal constant FEE_BPS = 100;

    function setUp() public {
        quoteAuthority = vm.addr(QUOTE_AUTHORITY_PK);
        pyth = new MockPyth(60, 1 wei);
        factory = new TendSeriesFactory(address(this), emergencyAdmin, pyth);
        token = new MockERC20("Mock USD", "mUSD", 6);
        vault = new TendPoolVault(
            address(factory), address(token), address(this), quoteAuthority, 8_000, 5_000, FEE_BPS, feeRecipient
        );

        expiry = uint64(block.timestamp + 16 minutes);
        lastTradeAt = expiry - 60;
        seriesId = factory.createSeries(
            TendSeriesFactory.CreateSeriesParams({
                pythFeedId: feedId,
                settlementToken: address(token),
                expiry: expiry,
                observationWindow: OBS_WINDOW,
                settlementGrace: GRACE,
                maxConfidenceBps: 2_000,
                symbol: bytes32("TEST-EXPIRY")
            })
        );
        vault.authorizeSeries(seriesId, true, lastTradeAt);

        token.mint(lp, 1_000_000e6);
        token.mint(buyer, 1_000e6);
        vm.prank(lp);
        token.approve(address(vault), type(uint256).max);
        vm.prank(buyer);
        token.approve(address(vault), type(uint256).max);
    }

    function _deposit(uint256 amount) internal returns (uint256 shares) {
        vm.prank(lp);
        shares = vault.deposit(amount, 0, block.timestamp + 1);
    }

    function _quote(uint256 nonce) internal view returns (TendPoolVault.PoolQuote memory) {
        return TendPoolVault.PoolQuote({
            nonce: nonce,
            direction: uint8(TendPoolVault.Direction.Up),
            strike: 100e8,
            width: 20e8,
            premium: 10e6,
            maxPayout: 1_000e6,
            quoteExpiry: uint64(block.timestamp + 5 minutes),
            seriesId: seriesId,
            buyer: buyer
        });
    }

    function _sign(TendPoolVault.PoolQuote memory quote, uint256 pk) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                vault.POOL_QUOTE_TYPEHASH(),
                quote.nonce,
                quote.direction,
                quote.strike,
                quote.width,
                quote.premium,
                quote.maxPayout,
                quote.quoteExpiry,
                quote.seriesId,
                quote.buyer
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _fill(uint256 nonce) internal returns (uint256 positionId) {
        TendPoolVault.PoolQuote memory quote = _quote(nonce);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        positionId = vault.fillPoolQuote(quote, signature);
    }

    function _closeQuote(uint256 nonce, uint256 positionId, uint128 bid, uint64 quoteExpiry_)
        internal
        view
        returns (TendPoolVault.CloseQuote memory)
    {
        return TendPoolVault.CloseQuote({
            nonce: nonce,
            positionId: positionId,
            bid: bid,
            quoteExpiry: quoteExpiry_,
            seller: buyer
        });
    }

    function _signClose(TendPoolVault.CloseQuote memory quote, uint256 pk) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                vault.CLOSE_QUOTE_TYPEHASH(),
                quote.nonce,
                quote.positionId,
                quote.bid,
                quote.quoteExpiry,
                quote.seller
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vault.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _close(uint256 nonce, uint256 positionId, uint128 bid) internal returns (uint256) {
        TendPoolVault.CloseQuote memory quote =
            _closeQuote(nonce, positionId, bid, uint64(block.timestamp + 5 minutes));
        bytes memory signature = _signClose(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        return vault.closePosition(quote, signature);
    }

    /// The vault's cash must always equal what it has promised: free assets,
    /// escrowed collateral and escrowed premium. Asserted around every early
    /// exit below.
    function _assertVaultSolvent() internal view {
        assertEq(
            token.balanceOf(address(vault)),
            vault.totalAssets() + vault.lockedCollateral() + vault.escrowedPremium(),
            "vault holdings != obligations"
        );
    }

    function _publishSettlement(int64 rawPrice) internal {
        bytes[] memory data = new bytes[](1);
        data[0] = pyth.createPriceFeedUpdateData(feedId, rawPrice, 1_000_000, -8, rawPrice, 1_000_000, expiry, 0);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(address(this), 1 ether);
        factory.publishSettlement{value: fee}(seriesId, data);
    }

    // -- share math: exact Solana unit vectors (math.rs tests) ---------------

    function test_ShareMath_SolanaUnitVectors() public view {
        // First deposit mints 1:1.
        assertEq(vault.calculateDepositShares(1_000, 0, 0), 1_000);
        // Deposit 333 into {shares 1000, assets 3000} -> 111 (rounded down).
        assertEq(vault.calculateDepositShares(333, 1_000, 3_000), 111);
        // Withdraw 111 from {shares 1000, assets 3001} -> 333 (rounded down).
        assertEq(vault.calculateWithdrawAmount(111, 1_000, 3_001), 333);
        // BPS limit vector.
        assertEq(vault.calculateBpsLimit(10_000, 7_500), 7_500);
    }

    function test_ShareMath_InsolventAndDustCasesRevert() public {
        // Deposit into insolvent pool (assets == 0, shares > 0) reverts.
        vm.expectRevert(TendPoolVault.PoolInsolvent.selector);
        vault.calculateDepositShares(1, 1, 0);
        // Dust deposit yielding zero shares reverts (Solana: 1 into {1, u64::MAX}).
        vm.expectRevert(TendPoolVault.DepositTooSmall.selector);
        vault.calculateDepositShares(1, 1, type(uint64).max);
        // Zero amounts revert.
        vm.expectRevert(TendPoolVault.InvalidAmount.selector);
        vault.calculateDepositShares(0, 0, 0);
        vm.expectRevert(TendPoolVault.InvalidAmount.selector);
        vault.calculateWithdrawAmount(0, 1_000, 3_000);
        // Withdraw from empty pool / more shares than exist revert.
        vm.expectRevert(TendPoolVault.InvalidPoolShares.selector);
        vault.calculateWithdrawAmount(1, 0, 0);
        vm.expectRevert(TendPoolVault.InvalidPoolShares.selector);
        vault.calculateWithdrawAmount(1_001, 1_000, 3_000);
        // Dust withdrawal yielding zero assets reverts.
        vm.expectRevert(TendPoolVault.DepositTooSmall.selector);
        vault.calculateWithdrawAmount(1, type(uint64).max, 1);
    }

    function test_FeeRoundsUp() public view {
        // Solana math.rs: calculate_fee(1, 25) == 1, calculate_fee(10_000, 25) == 25.
        assertEq(vault.calculateFee(1, 25), 1);
        assertEq(vault.calculateFee(10_000, 25), 25);
        assertEq(vault.calculateFee(10_000, 0), 0);
        assertEq(vault.calculateFee(0, 25), 0);
    }

    // -- payout math: linear, directional, capped (math.rs vectors + fuzz) ----

    function test_PayoutIsLinearDirectionalAndCapped() public view {
        assertEq(vault.calculatePayout(0, 100, 20, 90, 1_000), 0);
        assertEq(vault.calculatePayout(0, 100, 20, 110, 1_000), 500);
        assertEq(vault.calculatePayout(0, 100, 20, 150, 1_000), 1_000);
        assertEq(vault.calculatePayout(1, 100, 20, 90, 1_000), 500);
        assertEq(vault.calculatePayout(1, 100, 20, 50, 1_000), 1_000);
    }

    function test_OneTickWidthIsStrictBinaryAtExpiry() public view {
        // Quotes retain the deployed ABI and use width=1 raw price tick. A
        // strict favourable settlement pays all collateral; a tie loses.
        assertEq(vault.calculatePayout(0, 100e8, 1, 100e8 - 1, 15e6), 0);
        assertEq(vault.calculatePayout(0, 100e8, 1, 100e8, 15e6), 0);
        assertEq(vault.calculatePayout(0, 100e8, 1, 100e8 + 1, 15e6), 15e6);
        assertEq(vault.calculatePayout(1, 100e8, 1, 100e8 + 1, 15e6), 0);
        assertEq(vault.calculatePayout(1, 100e8, 1, 100e8, 15e6), 0);
        assertEq(vault.calculatePayout(1, 100e8, 1, 100e8 - 1, 15e6), 15e6);
    }

    function testFuzz_PayoutNeverExceedsCollateral(
        uint8 direction,
        uint128 strike,
        uint128 width,
        uint128 price,
        uint128 maxPayout
    ) public view {
        direction = direction % 2;
        width = uint128(bound(width, 1, type(uint128).max));
        maxPayout = uint128(bound(maxPayout, 1, type(uint128).max));
        uint256 payout = vault.calculatePayout(direction, strike, width, price, maxPayout);
        assertLe(payout, maxPayout, "payout exceeds collateral");
    }

    function testFuzz_SettlementConservesEscrow(
        uint8 direction,
        uint128 strike,
        uint128 width,
        uint128 price,
        uint128 maxPayout,
        uint128 premium,
        uint16 feeBps
    ) public view {
        direction = direction % 2;
        width = uint128(bound(width, 1, type(uint128).max));
        maxPayout = uint128(bound(maxPayout, 1, type(uint128).max));
        premium = uint128(bound(premium, 1, type(uint128).max));
        feeBps = uint16(bound(feeBps, 0, 1_000));

        uint256 payout = vault.calculatePayout(direction, strike, width, price, maxPayout);
        uint256 fee = vault.calculateFee(premium, feeBps);
        uint256 maker = uint256(maxPayout) - payout + premium - fee;
        assertEq(payout + maker + fee, uint256(maxPayout) + premium, "escrow not conserved");
    }

    // -- deposits / withdrawals ------------------------------------------------

    function test_FirstDepositMintsOneToOne() public {
        uint256 shares = _deposit(10_000e6);
        assertEq(shares, 10_000e6);
        assertEq(vault.totalShares(), 10_000e6);
        assertEq(vault.totalAssets(), 10_000e6);
        assertEq(vault.sharesOf(lp), 10_000e6);
        assertEq(token.balanceOf(address(vault)), 10_000e6);
    }

    function test_WithdrawReturnsAssets() public {
        _deposit(10_000e6);
        vm.prank(lp);
        uint256 amount = vault.withdraw(4_000e6, 0, block.timestamp + 1);
        assertEq(amount, 4_000e6);
        assertEq(vault.totalShares(), 6_000e6);
        assertEq(vault.totalAssets(), 6_000e6);
        assertEq(token.balanceOf(lp), 1_000_000e6 - 6_000e6);
    }

    function test_DepositsAndWithdrawalsBlockedWhileObligationsOpen() public {
        _deposit(10_000e6);
        _fill(1);

        vm.prank(lp);
        vm.expectRevert(TendPoolVault.PoolHasOpenPositions.selector);
        vault.deposit(1_000e6, 0, block.timestamp + 1);

        vm.prank(lp);
        vm.expectRevert(TendPoolVault.PoolHasOpenPositions.selector);
        vault.withdraw(1_000e6, 0, block.timestamp + 1);
    }

    function test_LifecycleReopensLiquidityAfterSettlement() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        vm.warp(expiry);
        _publishSettlement(110e8);
        vault.settlePoolPosition(positionId);

        // Obligations cleared: LP can withdraw everything that remains.
        assertEq(vault.openPositions(), 0);
        assertEq(vault.lockedCollateral(), 0);
        vm.prank(lp);
        uint256 amount = vault.withdraw(10_000e6, 0, block.timestamp + 1);
        // 9_000e6 free + (1_000e6 - 500e6 payout + 10e6 premium - 0.1e6 fee) returned.
        assertEq(amount, 9_509_900_000);
        assertEq(vault.totalShares(), 0);
        assertEq(vault.totalAssets(), 0);
    }

    // -- fills -------------------------------------------------------------

    function test_FillEscrowsCollateralAndPremium() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        assertEq(positionId, 1);

        assertEq(vault.totalAssets(), 9_000e6);
        assertEq(vault.lockedCollateral(), 1_000e6);
        assertEq(vault.escrowedPremium(), 10e6);
        assertEq(vault.openPositions(), 1);
        // Full escrow physically present in the vault.
        assertEq(token.balanceOf(address(vault)), 10_010e6);
        assertEq(token.balanceOf(buyer), 1_000e6 - 10e6);
    }

    function test_ReplayedQuoteRejected() public {
        _deposit(10_000e6);
        TendPoolVault.PoolQuote memory quote = _quote(1);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vault.fillPoolQuote(quote, signature);

        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.AlreadyFilled.selector);
        vault.fillPoolQuote(quote, signature);
    }

    function test_WrongSignerRejected() public {
        _deposit(10_000e6);
        TendPoolVault.PoolQuote memory quote = _quote(1);
        bytes memory signature = _sign(quote, WRONG_SIGNER_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.BadSignature.selector);
        vault.fillPoolQuote(quote, signature);
    }

    function test_ExpiredQuoteRejected() public {
        _deposit(10_000e6);
        TendPoolVault.PoolQuote memory quote = _quote(1);
        quote.quoteExpiry = uint64(block.timestamp);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.warp(block.timestamp + 1);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.QuoteExpired.selector);
        vault.fillPoolQuote(quote, signature);
    }

    function test_TamperedQuoteRejected() public {
        _deposit(10_000e6);
        TendPoolVault.PoolQuote memory quote = _quote(1);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        quote.premium = 1;
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.BadSignature.selector);
        vault.fillPoolQuote(quote, signature);
    }

    function test_OnlyNamedBuyerCanFill() public {
        _deposit(10_000e6);
        TendPoolVault.PoolQuote memory quote = _quote(1);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(address(0xD00D));
        vm.expectRevert(TendPoolVault.InvalidBuyer.selector);
        vault.fillPoolQuote(quote, signature);
    }

    function test_UtilizationCapEnforced() public {
        _deposit(1_000e6);
        // maxPayout 1_000e6 > 80% of 1_000e6 -> utilization exceeded.
        TendPoolVault.PoolQuote memory quote = _quote(1);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.PoolUtilizationExceeded.selector);
        vault.fillPoolQuote(quote, signature);
    }

    function test_PerPositionCapEnforced() public {
        _deposit(1_900e6);
        // 80% cap = 1_520e6 passes; 50% per-position cap = 950e6 < 1_000e6 fails.
        TendPoolVault.PoolQuote memory quote = _quote(1);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.PoolPositionLimitExceeded.selector);
        vault.fillPoolQuote(quote, signature);
    }

    function test_FillRejectedAfterLastTradeCutoff() public {
        _deposit(10_000e6);
        vm.warp(lastTradeAt);
        TendPoolVault.PoolQuote memory quote = _quote(1);
        quote.quoteExpiry = lastTradeAt;
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.LastTradeCutoffReached.selector);
        vault.fillPoolQuote(quote, signature);
    }

    // -- settlement ---------------------------------------------------------

    function test_SettleAgainstPythPrice_ExactEscrowConservation() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        vm.warp(expiry);
        _publishSettlement(110e8); // normalized 110e8; strike 100e8, width 20e8 -> half payout

        uint256 buyerBefore = token.balanceOf(buyer);
        uint256 payout = vault.settlePoolPosition(positionId);

        uint256 expectedPayout = 500e6;
        uint256 expectedFee = 100_000; // ceil(10e6 * 100 / 10000)
        uint256 expectedPoolAmount = 1_000e6 - expectedPayout + 10e6 - expectedFee;

        assertEq(payout, expectedPayout);
        assertEq(token.balanceOf(buyer) - buyerBefore, expectedPayout);
        assertEq(token.balanceOf(feeRecipient), expectedFee);
        assertEq(vault.totalAssets(), 9_000e6 + expectedPoolAmount);
        assertEq(vault.lockedCollateral(), 0);
        assertEq(vault.escrowedPremium(), 0);
        assertEq(vault.openPositions(), 0);
        // payout + poolAmount + fee == maxPayout + premium, on real token balances.
        assertEq(expectedPayout + expectedPoolAmount + expectedFee, 1_000e6 + 10e6);
        assertEq(token.balanceOf(address(vault)), vault.totalAssets());
    }

    function test_SettleCappedPayout_BuyerGetsMaxPayout() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        vm.warp(expiry);
        _publishSettlement(150e8); // above strike + width -> capped

        uint256 payout = vault.settlePoolPosition(positionId);
        assertEq(payout, 1_000e6);
    }

    function test_SettleOutOfTheMoney_PoolKeepsCollateral() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        vm.warp(expiry);
        _publishSettlement(90e8); // below strike -> zero payout

        uint256 payout = vault.settlePoolPosition(positionId);
        assertEq(payout, 0);
        assertEq(vault.totalAssets(), 10_000e6 + 10e6 - 100_000);
    }

    function test_SettleRevertsWithoutFinalizedSettlement() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        vm.warp(expiry);
        vm.expectRevert(TendPoolVault.NotFinalized.selector);
        vault.settlePoolPosition(positionId);
    }

    function test_SettleOnlyOnce() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        vm.warp(expiry);
        _publishSettlement(110e8);
        vault.settlePoolPosition(positionId);
        vm.expectRevert(TendPoolVault.AlreadySettled.selector);
        vault.settlePoolPosition(positionId);
    }

    // -- timeout refund -----------------------------------------------------

    function test_RefundAfterOracleTimeout() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);

        // Not refundable while the settlement window is open.
        vm.warp(uint256(expiry) + OBS_WINDOW + GRACE);
        vm.expectRevert(TendPoolVault.SettlementWindowOpen.selector);
        vault.refundPoolPosition(positionId);

        vm.warp(uint256(expiry) + OBS_WINDOW + GRACE + 1);
        uint256 buyerBefore = token.balanceOf(buyer);
        // Anyone may trigger the refund.
        vm.prank(address(0xD00D));
        vault.refundPoolPosition(positionId);

        // Buyer gets the premium back; pool gets its collateral back.
        assertEq(token.balanceOf(buyer) - buyerBefore, 10e6);
        assertEq(vault.totalAssets(), 10_000e6);
        assertEq(vault.lockedCollateral(), 0);
        assertEq(vault.openPositions(), 0);
        assertEq(token.balanceOf(address(vault)), 10_000e6);
    }

    function test_RefundOnlyOnce() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        vm.warp(uint256(expiry) + OBS_WINDOW + GRACE + 1);
        vault.refundPoolPosition(positionId);
        vm.expectRevert(TendPoolVault.AlreadySettled.selector);
        vault.refundPoolPosition(positionId);
    }

    function test_RefundBlockedOnceSettlementFinalized() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);
        vm.warp(expiry);
        _publishSettlement(110e8);
        vm.warp(uint256(expiry) + OBS_WINDOW + GRACE + 1);
        vm.expectRevert(TendPoolVault.SettlementWindowOpen.selector);
        vault.refundPoolPosition(positionId);
        // Settlement still works after the window closes.
        vault.settlePoolPosition(positionId);
    }

    // -- permissionless creation vs manager-only administration ---------------

    /// @dev Deployment stays permissionless (`rando`, not the test contract,
    /// sends the deploy transaction) but the manager is now whatever address
    /// is explicitly passed to the constructor, never implicitly `msg.sender`
    /// — the exact bug this constructor change closes.
    function test_AnyoneCanDeployAPool_ManagerIsThePassedAddressNotTheDeployer() public {
        address rando = address(0xF00);
        address namedManager = address(0xCAFE4);
        vm.prank(rando);
        TendPoolVault newVault = new TendPoolVault(
            address(factory), address(token), namedManager, quoteAuthority, 8_000, 5_000, FEE_BPS, feeRecipient
        );
        assertEq(newVault.manager(), namedManager);
        assertTrue(newVault.manager() != rando);
    }

    function test_ConstructorRejectsZeroManager() public {
        vm.expectRevert(TendPoolVault.InvalidAuthority.selector);
        new TendPoolVault(
            address(factory), address(token), address(0), quoteAuthority, 8_000, 5_000, FEE_BPS, feeRecipient
        );
    }

    function test_NonManagerCannotAuthorizeSeries() public {
        vm.prank(address(0xF00));
        vm.expectRevert(TendPoolVault.NotManager.selector);
        vault.authorizeSeries(seriesId, true, lastTradeAt);
    }

    function test_NonManagerCannotUpdatePool() public {
        vm.prank(address(0xF00));
        vm.expectRevert(TendPoolVault.NotManager.selector);
        vault.updatePool(quoteAuthority, 8_000, 5_000, FEE_BPS, feeRecipient);
    }

    function test_ManagerUpdatesBlockedWhileObligationsOpen() public {
        _deposit(10_000e6);
        _fill(1);
        vm.expectRevert(TendPoolVault.PoolHasOpenPositions.selector);
        vault.updatePool(quoteAuthority, 8_000, 5_000, FEE_BPS, feeRecipient);
        vm.expectRevert(TendPoolVault.PoolHasOpenPositions.selector);
        vault.authorizeSeries(seriesId, false, 0);
    }

    // -- authorizeSeries guard relaxation: new series only ---------------------
    //
    // See the @dev comment on authorizeSeries itself for the full safety
    // argument. Short version: fillPoolQuote enforces solvency per fill
    // against live balances, so authorizing an ADDITIONAL brand-new series
    // touches none of those balances and cannot itself make the pool
    // insolvent. Touching an EXISTING seriesAuth entry (disable, or
    // re-authorize) is different — it changes semantics for a series people
    // may already be trading — and stays gated on a flat pool.

    /// @dev Creates and returns a second series (distinct symbol/expiry from
    /// setUp's `seriesId`), NOT yet authorized on the vault.
    function _createUnauthorizedSeries(uint64 expiry_) internal returns (bytes32) {
        return factory.createSeries(
            TendSeriesFactory.CreateSeriesParams({
                pythFeedId: feedId,
                settlementToken: address(token),
                expiry: expiry_,
                observationWindow: OBS_WINDOW,
                settlementGrace: GRACE,
                maxConfidenceBps: 2_000,
                symbol: bytes32("TEST-NEW")
            })
        );
    }

    function test_NewSeriesCanBeAuthorizedWhilePositionsOpen() public {
        _deposit(10_000e6);
        _fill(1); // opens a position + locks collateral against `seriesId`

        uint64 newExpiry = uint64(block.timestamp + 20 minutes);
        bytes32 newSeriesId = _createUnauthorizedSeries(newExpiry);
        uint64 newLastTradeAt = newExpiry - 60;

        // Must NOT revert PoolHasOpenPositions — this seriesId has never been
        // authorized before, so it is a genuinely new authorization.
        vault.authorizeSeries(newSeriesId, true, newLastTradeAt);

        (bool enabled, uint64 storedLastTradeAt) = vault.seriesAuth(newSeriesId);
        assertTrue(enabled);
        assertEq(storedLastTradeAt, newLastTradeAt);
    }

    function test_DisablingSeriesStillBlockedWhilePositionsOpen() public {
        _deposit(10_000e6);
        _fill(1);

        // `seriesId` already has a seriesAuth entry (authorized in setUp) —
        // disabling it is a real semantic change for anyone already trading
        // it, so it stays behind the flat-pool guard.
        vm.expectRevert(TendPoolVault.PoolHasOpenPositions.selector);
        vault.authorizeSeries(seriesId, false, 0);
    }

    function test_ReauthorizingExistingSeriesStillBlockedWhilePositionsOpen() public {
        _deposit(10_000e6);
        _fill(1);

        // Re-authorizing (enabled=true) a seriesId that already has an entry
        // is NOT a "new" authorization under the relaxed guard — it still
        // requires a flat pool, even with the same lastTradeAt as before.
        vm.expectRevert(TendPoolVault.PoolHasOpenPositions.selector);
        vault.authorizeSeries(seriesId, true, lastTradeAt);
    }

    /// Regression: a disable must not be able to ERASE the seriesAuth entry and
    /// thereby disguise a later re-enable as a first-ever authorization.
    ///
    /// `lastTradeAt` is only validated on the `enabled` branch, so a disable
    /// can legitimately pass 0. If that 0 were stored, `seriesAuth[id]` would
    /// read back as {false, 0} — exactly the shape `isNewAuthorization` treats
    /// as "never authorized" — and the re-enable would skip the
    /// open-obligations guard that test_ReauthorizingExistingSeriesStillBlocked
    /// above asserts it must obey. authorizeSeries therefore PRESERVES the
    /// stored cutoff when disabling.
    function test_DisableWithZeroCutoffCannotDisguiseReauthorizationAsNew() public {
        _deposit(10_000e6);

        // Disable while flat (allowed), passing 0 as the cutoff.
        vault.authorizeSeries(seriesId, false, 0);
        (bool enabledAfterDisable, uint64 cutoffAfterDisable) = vault.seriesAuth(seriesId);
        assertFalse(enabledAfterDisable);
        assertEq(cutoffAfterDisable, lastTradeAt, "disable must preserve the historical cutoff, not zero it");

        // Re-authorize it while flat so a position can be opened against it.
        vault.authorizeSeries(seriesId, true, lastTradeAt);
        _fill(1);

        // Now the pool has open obligations. Re-authorizing this seriesId is
        // still a re-authorization, not a new one, so it must be refused.
        vm.expectRevert(TendPoolVault.PoolHasOpenPositions.selector);
        vault.authorizeSeries(seriesId, true, lastTradeAt);
    }

    function test_FillAgainstNewlyAuthorizedSeries_StillEnforcesRiskChecks() public {
        _deposit(10_000e6);
        _fill(1); // locks 1_000e6 against `seriesId`; totalAssets=9_000e6, lockedCollateral=1_000e6

        uint64 newExpiry = uint64(block.timestamp + 20 minutes);
        bytes32 newSeriesId = _createUnauthorizedSeries(newExpiry);
        vault.authorizeSeries(newSeriesId, true, newExpiry - 60);

        // totalCollateral = totalAssets + lockedCollateral = 10_000e6
        // throughout this test (fills only move value between the two, they
        // don't change the sum) -> utilizationLimit = 8_000e6 (80%),
        // positionLimit = 5_000e6 (50%), same pool risk limits as setUp.

        // A within-limits fill against the newly authorized series succeeds
        // exactly like any other series.
        TendPoolVault.PoolQuote memory okQuote = _quote(2);
        okQuote.seriesId = newSeriesId;
        okQuote.maxPayout = 500e6;
        bytes memory okSignature = _sign(okQuote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vault.fillPoolQuote(okQuote, okSignature);
        assertEq(vault.lockedCollateral(), 1_000e6 + 500e6);

        // A fill against it that would breach the 50% per-position cap still
        // reverts — authorizing while positions were open never weakened
        // fillPoolQuote's own checks.
        TendPoolVault.PoolQuote memory overQuote = _quote(3);
        overQuote.seriesId = newSeriesId;
        overQuote.maxPayout = 6_000e6; // > 5_000e6 position limit
        bytes memory overSignature = _sign(overQuote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.PoolPositionLimitExceeded.selector);
        vault.fillPoolQuote(overQuote, overSignature);

        // A fill that would breach the 80% utilization cap also still
        // reverts.
        TendPoolVault.PoolQuote memory utilQuote = _quote(4);
        utilQuote.seriesId = newSeriesId;
        utilQuote.maxPayout = 7_600e6; // lockedAfter = 1_500e6 + 7_600e6 > 8_000e6
        bytes memory utilSignature = _sign(utilQuote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.PoolUtilizationExceeded.selector);
        vault.fillPoolQuote(utilQuote, utilSignature);

        // The third check — `if (totalAssets < quote.maxPayout) revert
        // InsufficientLiquidity()` — is untouched by this change too, but is
        // not independently triggerable here: whenever maxUtilizationBps <=
        // BPS_DENOMINATOR (always true — _validatePoolRiskLimits enforces
        // it), `lockedAfter <= utilizationLimit` algebraically implies
        // `maxPayout <= totalAssets` (totalCollateral = totalAssets +
        // lockedCollateral, so lockedCollateral + maxPayout <= bps/10000 *
        // (totalAssets + lockedCollateral) <= totalAssets + lockedCollateral
        // rearranges to maxPayout <= totalAssets). So the utilization check
        // passing already guarantees liquidity is sufficient — this is a
        // pre-existing contract invariant, unrelated to and unweakened by
        // the authorizeSeries guard change; no existing test in this suite
        // isolates InsufficientLiquidity either, for the same reason.
        assertEq(vault.totalAssets(), 10_000e6 - 1_000e6 - 500e6);
    }

    function test_ManagerCanRotateQuoteAuthority_OldQuotesRejected() public {
        _deposit(10_000e6);
        vault.updatePool(vm.addr(WRONG_SIGNER_PK), 8_000, 5_000, FEE_BPS, feeRecipient);

        TendPoolVault.PoolQuote memory quote = _quote(1);
        bytes memory oldAuthoritySig = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.BadSignature.selector);
        vault.fillPoolQuote(quote, oldAuthoritySig);

        bytes memory newAuthoritySig = _sign(quote, WRONG_SIGNER_PK);
        vm.prank(buyer);
        vault.fillPoolQuote(quote, newAuthoritySig);
    }

    function test_InvalidRiskLimitsRejected() public {
        vm.expectRevert(TendPoolVault.InvalidPoolRiskLimits.selector);
        new TendPoolVault(address(factory), address(token), address(this), quoteAuthority, 0, 0, FEE_BPS, feeRecipient);
        vm.expectRevert(TendPoolVault.InvalidPoolRiskLimits.selector);
        new TendPoolVault(
            address(factory), address(token), address(this), quoteAuthority, 10_001, 5_000, FEE_BPS, feeRecipient
        );
        vm.expectRevert(TendPoolVault.InvalidPoolRiskLimits.selector);
        new TendPoolVault(
            address(factory), address(token), address(this), quoteAuthority, 5_000, 8_000, FEE_BPS, feeRecipient
        );
    }

    // -- manager handover -----------------------------------------------------

    function test_ManagerTransfersAndNewManagerControlsOldManagerLocked() public {
        address newManager = address(0xCAFE3);
        vault.transferManager(newManager);
        assertEq(vault.manager(), newManager);

        vm.prank(newManager);
        vault.updatePool(quoteAuthority, 8_000, 5_000, FEE_BPS, feeRecipient);

        vm.prank(newManager);
        vault.authorizeSeries(seriesId, true, lastTradeAt);

        vm.expectRevert(TendPoolVault.NotManager.selector);
        vault.updatePool(quoteAuthority, 8_000, 5_000, FEE_BPS, feeRecipient);

        vm.expectRevert(TendPoolVault.NotManager.selector);
        vault.authorizeSeries(seriesId, true, lastTradeAt);
    }

    function test_NonManagerCannotTransferManager() public {
        vm.prank(address(0xF00));
        vm.expectRevert(TendPoolVault.NotManager.selector);
        vault.transferManager(address(0xCAFE3));
    }

    function test_TransferManagerToZeroAddressReverts() public {
        vm.expectRevert(TendPoolVault.InvalidAuthority.selector);
        vault.transferManager(address(0));
    }

    function test_TransferManagerBlockedWhileObligationsOpen() public {
        _deposit(10_000e6);
        _fill(1);
        vm.expectRevert(TendPoolVault.PoolHasOpenPositions.selector);
        vault.transferManager(address(0xCAFE3));
    }

    // -- guardian pause: blocks new fills, never settlement/refund -------------

    function test_GuardianPauseBlocksNewFillsButNotSettlement() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);

        factory.setPaused(true);

        TendPoolVault.PoolQuote memory quote = _quote(2);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.SeriesNotTradable.selector);
        vault.fillPoolQuote(quote, signature);

        // Settlement publication and position settlement still work while paused.
        vm.warp(expiry);
        _publishSettlement(110e8);
        uint256 payout = vault.settlePoolPosition(positionId);
        assertEq(payout, 500e6);
    }

    function test_GuardianDisableBlocksNewFillsButNotRefund() public {
        _deposit(10_000e6);
        uint256 positionId = _fill(1);

        factory.setSeriesEnabled(seriesId, false);

        TendPoolVault.PoolQuote memory quote = _quote(2);
        bytes memory signature = _sign(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.SeriesNotTradable.selector);
        vault.fillPoolQuote(quote, signature);

        // Timeout refund still works on the disabled series.
        vm.warp(uint256(expiry) + OBS_WINDOW + GRACE + 1);
        vault.refundPoolPosition(positionId);
        assertEq(vault.openPositions(), 0);
    }

    // -- early exit: selling a position back to the pool -------------------

    function test_ClosePosition_PaysSignedBidAndReleasesEscrow() public {
        uint256 deposited = 100_000e6;
        _deposit(deposited);
        uint256 positionId = _fill(1);

        uint256 buyerBefore = token.balanceOf(buyer);
        uint128 bid = 250e6;
        uint256 paid = _close(2, positionId, bid);

        assertEq(paid, bid, "returned bid");
        assertEq(token.balanceOf(buyer) - buyerBefore, bid, "buyer received the bid");

        // Escrow released in full; the premium (less fee) stays with the pool.
        uint256 fee = vault.calculateFee(10e6, FEE_BPS);
        assertEq(vault.lockedCollateral(), 0, "collateral released");
        assertEq(vault.escrowedPremium(), 0, "premium escrow released");
        assertEq(vault.openPositions(), 0, "position no longer open");
        assertEq(vault.totalAssets(), deposited - bid + 10e6 - fee, "pool assets = deposit - bid + premium - fee");
        _assertVaultSolvent();

        (,,,,,,,, bool settled, bool closed, uint128 recordedBid) = vault.positions(positionId);
        assertTrue(settled, "terminal");
        assertTrue(closed, "flagged as closed, not settled");
        assertEq(recordedBid, bid, "exit price recorded on the position");

        // Releasing the escrow clears the open-position gate, so liquidity is
        // withdrawable again immediately.
        vm.prank(lp);
        vault.withdraw(1_000e6, 0, block.timestamp + 1);
    }

    function test_ClosePosition_RejectsBidAboveEscrow() public {
        _deposit(100_000e6);
        uint256 positionId = _fill(1);

        TendPoolVault.CloseQuote memory quote =
            _closeQuote(2, positionId, 1_000e6 + 1, uint64(block.timestamp + 5 minutes));
        bytes memory signature = _signClose(quote, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.BidExceedsEscrow.selector);
        vault.closePosition(quote, signature);
    }

    function test_ClosePosition_RejectsForeignSellerAndBadSignature() public {
        _deposit(100_000e6);
        uint256 positionId = _fill(1);

        // Someone else cannot lift the holder's bid.
        TendPoolVault.CloseQuote memory quote =
            _closeQuote(2, positionId, 100e6, uint64(block.timestamp + 5 minutes));
        bytes memory signature = _signClose(quote, QUOTE_AUTHORITY_PK);
        vm.prank(address(0xDEAD));
        vm.expectRevert(TendPoolVault.InvalidBuyer.selector);
        vault.closePosition(quote, signature);

        // A bid the quote authority did not sign is refused.
        bytes memory forged = _signClose(quote, WRONG_SIGNER_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.BadSignature.selector);
        vault.closePosition(quote, forged);
    }

    function test_ClosePosition_RejectsReplayAndDoubleExit() public {
        _deposit(100_000e6);
        uint256 positionId = _fill(1);
        _close(2, positionId, 100e6);

        // A spent nonce cannot be replayed against a DIFFERENT open position
        // (the position-state check fires first on the closed one, so the
        // replay has to be aimed at live collateral to test the nonce at all).
        uint256 livePositionId = _fill(10);
        TendPoolVault.CloseQuote memory replay =
            _closeQuote(2, livePositionId, 100e6, uint64(block.timestamp + 5 minutes));
        bytes memory replaySig = _signClose(replay, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.AlreadyFilled.selector);
        vault.closePosition(replay, replaySig);

        // Fresh nonce, already-closed position.
        TendPoolVault.CloseQuote memory second =
            _closeQuote(3, positionId, 100e6, uint64(block.timestamp + 5 minutes));
        bytes memory secondSig = _signClose(second, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.AlreadySettled.selector);
        vault.closePosition(second, secondSig);

        // And it can never also be settled for a payout.
        vm.warp(expiry + OBS_WINDOW);
        _publishSettlement(130e8);
        vm.expectRevert(TendPoolVault.AlreadySettled.selector);
        vault.settlePoolPosition(positionId);
        _assertVaultSolvent();
    }

    function test_ClosePosition_RejectsZeroBidExpiredQuoteAndExpiredSeries() public {
        _deposit(100_000e6);
        uint256 positionId = _fill(1);

        TendPoolVault.CloseQuote memory zero =
            _closeQuote(2, positionId, 0, uint64(block.timestamp + 5 minutes));
        bytes memory zeroSig = _signClose(zero, QUOTE_AUTHORITY_PK);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.InvalidAmount.selector);
        vault.closePosition(zero, zeroSig);

        TendPoolVault.CloseQuote memory stale =
            _closeQuote(3, positionId, 100e6, uint64(block.timestamp + 60));
        bytes memory staleSig = _signClose(stale, QUOTE_AUTHORITY_PK);
        vm.warp(block.timestamp + 61);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.QuoteExpired.selector);
        vault.closePosition(stale, staleSig);

        // Past expiry the position has a settlement price coming; a modelled
        // bid must not pre-empt it.
        TendPoolVault.CloseQuote memory late =
            _closeQuote(4, positionId, 100e6, uint64(expiry + 10 minutes));
        bytes memory lateSig = _signClose(late, QUOTE_AUTHORITY_PK);
        vm.warp(expiry);
        vm.prank(buyer);
        vm.expectRevert(TendPoolVault.SeriesExpired.selector);
        vault.closePosition(late, lateSig);
    }

    /// Whatever the desk signs, the pool pays the bid out of collateral this
    /// position already locked and stays exactly solvent.
    function testFuzz_CloseConservesEscrow(uint128 bid) public {
        bid = uint128(bound(uint256(bid), 1, 1_000e6));
        uint256 deposited = 100_000e6;
        _deposit(deposited);
        uint256 positionId = _fill(1);

        uint256 buyerBefore = token.balanceOf(buyer);
        _close(2, positionId, bid);

        uint256 fee = vault.calculateFee(10e6, FEE_BPS);
        assertEq(token.balanceOf(buyer) - buyerBefore, bid, "buyer paid exactly the bid");
        assertEq(vault.totalAssets(), deposited - bid + 10e6 - fee, "pool P&L = premium - fee - bid");
        assertEq(vault.lockedCollateral(), 0, "escrow fully released");
        assertEq(vault.escrowedPremium(), 0, "premium escrow fully released");
        _assertVaultSolvent();
    }
}
