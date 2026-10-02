// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {TendSeriesFactory} from "./TendSeriesFactory.sol";
import {TendPriceOracle} from "./TendPriceOracle.sol";

contract TendPriceOracleTest is Test {
    TendPriceOracle internal oracle;
    TendSeriesFactory internal factory;

    address internal admin = address(0xAD);
    address internal attacker = address(0xBAD);
    bytes32 internal feedId = bytes32(uint256(0xFEED));

    int64 internal constant PRICE = 8_300_000_000_000; // $83,000.00 at expo -8
    uint64 internal constant CONF = 1_000_000;
    int32 internal constant EXPO = -8;

    function setUp() public {
        oracle = new TendPriceOracle(admin);
        factory = new TendSeriesFactory(address(this), address(0xE33), IPyth(address(oracle)));
        vm.deal(attacker, 1 ether);
    }

    function _series() internal returns (bytes32 seriesId, uint64 expiry) {
        expiry = uint64(block.timestamp + 16 minutes);
        seriesId = factory.createSeries(
            TendSeriesFactory.CreateSeriesParams({
                pythFeedId: feedId,
                settlementToken: address(0xC01A),
                expiry: expiry,
                observationWindow: 60,
                settlementGrace: 3_600,
                maxConfidenceBps: 2_000,
                symbol: bytes32("TEST")
            })
        );
    }

    function _forgedUpdate(int64 price, uint64 publishTime) internal returns (bytes[] memory data) {
        MockPyth encoder = new MockPyth(60, 0);
        data = new bytes[](1);
        data[0] = encoder.createPriceFeedUpdateData(feedId, price, 1, EXPO, price, 1, publishTime, 0);
    }

    // -- the problem this contract exists to fix ------------------------------

    function test_MockPyth_LetsAnyoneSettleAtAnInventedPrice() public {
        MockPyth open = new MockPyth(60, 0);
        TendSeriesFactory openFactory = new TendSeriesFactory(address(this), address(0xE33), open);
        uint64 expiry = uint64(block.timestamp + 16 minutes);
        bytes32 seriesId = openFactory.createSeries(
            TendSeriesFactory.CreateSeriesParams({
                pythFeedId: feedId,
                settlementToken: address(0xC01A),
                expiry: expiry,
                observationWindow: 60,
                settlementGrace: 3_600,
                maxConfidenceBps: 2_000,
                symbol: bytes32("OPEN")
            })
        );
        vm.warp(expiry);
        vm.prank(attacker);
        openFactory.publishSettlement(seriesId, _forgedUpdate(999_999 * 1e8, expiry));
        assertEq(openFactory.getSettlement(seriesId).price, 999_999 * 1e8, "any caller chose the price");
    }

    // -- admin-only posting ---------------------------------------------------

    function test_AdminPostsAndAnyoneCanSettleAtThatPrice() public {
        (bytes32 seriesId, uint64 expiry) = _series();
        vm.warp(expiry);
        vm.prank(admin);
        oracle.postPrice(feedId, PRICE, CONF, EXPO, expiry);

        vm.prank(attacker);
        factory.publishSettlement(seriesId, new bytes[](0));
        TendSeriesFactory.Settlement memory s = factory.getSettlement(seriesId);
        assertTrue(s.finalized);
        assertEq(s.price, uint256(uint64(PRICE)), "settles at the admin price, not the caller's");
        assertEq(s.publishTime, expiry);
    }

    function test_NonAdminCannotPost() public {
        vm.prank(attacker);
        vm.expectRevert(TendPriceOracle.NotAdmin.selector);
        oracle.postPrice(feedId, PRICE, CONF, EXPO, uint64(block.timestamp));
    }

    function test_ForgedUpdateDataIsIgnored() public {
        (bytes32 seriesId, uint64 expiry) = _series();
        vm.warp(expiry);
        vm.prank(admin);
        oracle.postPrice(feedId, PRICE, CONF, EXPO, expiry);

        vm.prank(attacker);
        factory.publishSettlement(seriesId, _forgedUpdate(999_999 * 1e8, expiry));
        assertEq(factory.getSettlement(seriesId).price, uint256(uint64(PRICE)), "forged payload had no effect");
    }

    function test_SettlementRevertsUntilAdminPosts() public {
        (bytes32 seriesId, uint64 expiry) = _series();
        bytes[] memory forged = _forgedUpdate(999_999 * 1e8, expiry); // built first: expectRevert binds the next call
        vm.warp(expiry + 5);
        vm.prank(attacker);
        vm.expectRevert(TendPriceOracle.PriceNotPosted.selector);
        factory.publishSettlement(seriesId, forged);
    }

    function test_FirstPostAtOrAfterExpiryWins() public {
        (bytes32 seriesId, uint64 expiry) = _series();
        vm.warp(expiry + 10);
        vm.startPrank(admin);
        oracle.postPrice(feedId, PRICE + 500, CONF, EXPO, expiry + 7);
        oracle.postPrice(feedId, PRICE, CONF, EXPO, expiry + 2);
        oracle.postPrice(feedId, PRICE - 500, CONF, EXPO, expiry - 1); // before expiry: never eligible
        vm.stopPrank();

        factory.publishSettlement(seriesId, new bytes[](0));
        TendSeriesFactory.Settlement memory s = factory.getSettlement(seriesId);
        assertEq(s.publishTime, expiry + 2, "earliest in-window post, regardless of posting order");
        assertEq(s.price, uint256(uint64(PRICE)));
    }

    function test_PostOutsideTheSlackIsNotEligible() public {
        (bytes32 seriesId, uint64 expiry) = _series();
        vm.warp(expiry + 30);
        vm.prank(admin);
        oracle.postPrice(feedId, PRICE, CONF, EXPO, expiry + 20); // factory slack is 15s
        vm.expectRevert(TendPriceOracle.PriceNotPosted.selector);
        factory.publishSettlement(seriesId, new bytes[](0));
    }

    // -- post validation ------------------------------------------------------

    function test_PostsAreWriteOnce() public {
        vm.startPrank(admin);
        oracle.postPrice(feedId, PRICE, CONF, EXPO, uint64(block.timestamp));
        vm.expectRevert(TendPriceOracle.AlreadyPosted.selector);
        oracle.postPrice(feedId, PRICE + 1, CONF, EXPO, uint64(block.timestamp));
        vm.stopPrank();
    }

    function test_RejectsFuturePublishTime() public {
        vm.prank(admin);
        vm.expectRevert(TendPriceOracle.PublishTimeInFuture.selector);
        oracle.postPrice(feedId, PRICE, CONF, EXPO, uint64(block.timestamp + 1));
    }

    function test_RejectsNonPositivePrice() public {
        vm.startPrank(admin);
        vm.expectRevert(TendPriceOracle.InvalidPrice.selector);
        oracle.postPrice(feedId, 0, CONF, EXPO, uint64(block.timestamp));
        vm.expectRevert(TendPriceOracle.InvalidPrice.selector);
        oracle.postPrice(feedId, -1, CONF, EXPO, uint64(block.timestamp));
        vm.stopPrank();
    }

    function test_RejectsOutOfRangeExponent() public {
        vm.startPrank(admin);
        vm.expectRevert(TendPriceOracle.InvalidExponent.selector);
        oracle.postPrice(feedId, PRICE, CONF, -19, uint64(block.timestamp));
        vm.expectRevert(TendPriceOracle.InvalidExponent.selector);
        oracle.postPrice(feedId, PRICE, CONF, 1, uint64(block.timestamp));
        vm.stopPrank();
    }

    function test_RejectsAnOverlyWideQueryWindow() public {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = feedId;
        uint64 tooWide = oracle.MAX_QUERY_WINDOW() + 1; // read first: expectRevert binds the next call
        vm.expectRevert(TendPriceOracle.WindowTooWide.selector);
        oracle.parsePriceFeedUpdatesUnique(new bytes[](0), ids, 1, 1 + tooWide);
    }

    function test_QueryEndingAtMaxUint64DoesNotOverflow() public {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = feedId;
        uint64 top = type(uint64).max;
        vm.expectRevert(TendPriceOracle.PriceNotPosted.selector);
        oracle.parsePriceFeedUpdatesUnique(new bytes[](0), ids, top - 3, top);
    }

    // -- compatibility ----------------------------------------------------------

    function test_UpdatesAreFree() public view {
        assertEq(oracle.getUpdateFee(new bytes[](3)), 0);
    }

    function test_LegacyParseMatchesUnique() public {
        vm.prank(admin);
        oracle.postPrice(feedId, PRICE, CONF, EXPO, uint64(block.timestamp));
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = feedId;
        uint64 t = uint64(block.timestamp);
        PythStructs.PriceFeed[] memory a = oracle.parsePriceFeedUpdates(new bytes[](0), ids, t, t + 15);
        PythStructs.PriceFeed[] memory b = oracle.parsePriceFeedUpdatesUnique(new bytes[](0), ids, t, t + 15);
        assertEq(a[0].price.price, b[0].price.price);
        assertEq(a[0].price.publishTime, b[0].price.publishTime);
        assertEq(a[0].id, feedId);
    }

    function test_PriceAtReadsBackAPost() public {
        vm.prank(admin);
        oracle.postPrice(feedId, PRICE, CONF, EXPO, uint64(block.timestamp));
        PythStructs.Price memory p = oracle.priceAt(feedId, uint64(block.timestamp));
        assertEq(p.price, PRICE);
        assertEq(p.conf, CONF);
        assertEq(p.expo, EXPO);
    }

    // -- admin rotation -----------------------------------------------------------

    function test_AdminTransferIsTwoStep() public {
        address next = address(0xA2);
        vm.prank(admin);
        oracle.transferAdmin(next);
        assertEq(oracle.admin(), admin, "unchanged until accepted");

        vm.prank(attacker);
        vm.expectRevert(TendPriceOracle.NotPendingAdmin.selector);
        oracle.acceptAdmin();

        vm.prank(next);
        oracle.acceptAdmin();
        assertEq(oracle.admin(), next);

        vm.prank(admin);
        vm.expectRevert(TendPriceOracle.NotAdmin.selector);
        oracle.postPrice(feedId, PRICE, CONF, EXPO, uint64(block.timestamp));
    }

    function test_ConstructorRejectsZeroAdmin() public {
        vm.expectRevert(TendPriceOracle.ZeroAddress.selector);
        new TendPriceOracle(address(0));
    }
}
