// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {PythErrors} from "@pythnetwork/pyth-sdk-solidity/PythErrors.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {TendSeriesFactory} from "./TendSeriesFactory.sol";

// SDK 4.3.1's MockPyth.parsePriceFeedUpdatesUnique mistakenly passes
// checkUniqueness=false. Exercise its underlying parser with the documented
// flag instead. This models selection semantics, never signature verification.
contract UniquePythTestAdapter {
    MockPyth internal immutable mock;
    constructor(MockPyth mock_) { mock = mock_; }
    function getUpdateFee(bytes[] calldata data) external view returns (uint256) {
        return mock.getUpdateFee(data);
    }
    function parsePriceFeedUpdatesUnique(bytes[] calldata data, bytes32[] calldata ids, uint64 minTime, uint64 maxTime)
        external payable returns (PythStructs.PriceFeed[] memory feeds)
    {
        (feeds,) = mock.parsePriceFeedUpdatesWithConfig{value: msg.value}(data, ids, minTime, maxTime, true, true, false);
    }
}

contract TendSeriesFactoryTest is Test {
    TendSeriesFactory internal factory;
    MockPyth internal pyth;

    address internal owner = address(this);
    address internal emergencyAdmin = address(0xE33);
    address internal settlementToken = address(0xC01A);
    bytes32 internal feedId = bytes32(uint256(0xFEED));

    uint32 internal constant OBS_WINDOW = 60;
    uint32 internal constant GRACE = 3_600;
    uint16 internal constant MAX_CONF_BPS = 2_000;

    function setUp() public {
        pyth = new MockPyth(60, 1 wei);
        factory = new TendSeriesFactory(owner, emergencyAdmin, pyth);
    }

    function _params(uint64 expiry) internal view returns (TendSeriesFactory.CreateSeriesParams memory) {
        return TendSeriesFactory.CreateSeriesParams({
            pythFeedId: feedId,
            settlementToken: settlementToken,
            expiry: expiry,
            observationWindow: OBS_WINDOW,
            settlementGrace: GRACE,
            maxConfidenceBps: MAX_CONF_BPS,
            symbol: bytes32("TEST-EXPIRY")
        });
    }

    function _defaultParams() internal view returns (TendSeriesFactory.CreateSeriesParams memory) {
        return _params(uint64(block.timestamp + 16 minutes));
    }

    // -- creation ---------------------------------------------------------

    function test_AnyoneCanCreateASeries() public {
        address randomCreator = address(0xBEEF);
        vm.prank(randomCreator);
        bytes32 seriesId = factory.createSeries(_defaultParams());

        TendSeriesFactory.Series memory series = factory.getSeries(seriesId);
        assertEq(series.creator, randomCreator);
        assertTrue(series.enabled);
    }

    function test_DuplicateParamsResolveToSameIdAndRevert() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 firstId = factory.createSeries(params);
        bytes32 derived = factory.deriveSeriesId(params);
        assertEq(firstId, derived);

        vm.expectRevert(TendSeriesFactory.SeriesAlreadyExists.selector);
        factory.createSeries(params);
    }

    function test_SeriesIdBindsAllCanonicalParams() public view {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 expected = keccak256(
            abi.encode(
                "TENDMKT1",
                params.pythFeedId,
                params.settlementToken,
                params.expiry,
                params.observationWindow,
                params.settlementGrace,
                params.maxConfidenceBps,
                params.symbol
            )
        );
        assertEq(factory.deriveSeriesId(params), expected);

        TendSeriesFactory.CreateSeriesParams memory changed = params;
        changed.expiry = params.expiry + 1;
        assertNotEq(factory.deriveSeriesId(changed), expected);
        changed = params;
        changed.maxConfidenceBps = params.maxConfidenceBps - 1;
        assertNotEq(factory.deriveSeriesId(changed), expected);
        changed = params;
        changed.symbol = bytes32("OTHER");
        assertNotEq(factory.deriveSeriesId(changed), expected);
    }

    function test_RejectsExpiryBelowLeadTime() public {
        TendSeriesFactory.CreateSeriesParams memory params = _params(uint64(block.timestamp + 1 minutes));
        vm.expectRevert(TendSeriesFactory.InvalidExpiry.selector);
        factory.createSeries(params);
    }

    function test_RejectsObservationWindowOutOfBounds() public {
        TendSeriesFactory.CreateSeriesParams memory tooSmall = _defaultParams();
        tooSmall.observationWindow = 0;
        vm.expectRevert(TendSeriesFactory.InvalidObservationWindow.selector);
        factory.createSeries(tooSmall);

        TendSeriesFactory.CreateSeriesParams memory tooBig = _defaultParams();
        tooBig.observationWindow = uint32(1 hours) + 1;
        vm.expectRevert(TendSeriesFactory.InvalidObservationWindow.selector);
        factory.createSeries(tooBig);
    }

    function test_RejectsSettlementGraceOutOfBounds() public {
        TendSeriesFactory.CreateSeriesParams memory tooSmall = _defaultParams();
        tooSmall.settlementGrace = 0;
        vm.expectRevert(TendSeriesFactory.InvalidSettlementGrace.selector);
        factory.createSeries(tooSmall);

        TendSeriesFactory.CreateSeriesParams memory tooBig = _defaultParams();
        tooBig.settlementGrace = uint32(24 hours) + 1;
        vm.expectRevert(TendSeriesFactory.InvalidSettlementGrace.selector);
        factory.createSeries(tooBig);
    }

    function test_RejectsConfidenceOutOfBounds() public {
        TendSeriesFactory.CreateSeriesParams memory zero = _defaultParams();
        zero.maxConfidenceBps = 0;
        vm.expectRevert(TendSeriesFactory.InvalidConfidence.selector);
        factory.createSeries(zero);

        TendSeriesFactory.CreateSeriesParams memory tooBig = _defaultParams();
        tooBig.maxConfidenceBps = 2_001;
        vm.expectRevert(TendSeriesFactory.InvalidConfidence.selector);
        factory.createSeries(tooBig);
    }

    function test_RejectsCreationWhilePaused() public {
        factory.setPaused(true);
        vm.expectRevert(TendSeriesFactory.Paused.selector);
        factory.createSeries(_defaultParams());
    }

    // -- guardian -----------------------------------------------------------

    function test_OwnerCanDisableSeries_BlocksTradabilityOnly() public {
        bytes32 seriesId = factory.createSeries(_defaultParams());
        assertTrue(factory.isTradable(seriesId));

        factory.setSeriesEnabled(seriesId, false);
        assertFalse(factory.isTradable(seriesId));

        // Guardian disable never blocks refund eligibility computation.
        assertFalse(factory.isRefundable(seriesId));
    }

    function test_NonOwnerCannotDisableSeries() public {
        bytes32 seriesId = factory.createSeries(_defaultParams());
        vm.prank(address(0xBAD));
        vm.expectRevert(TendSeriesFactory.NotOwner.selector);
        factory.setSeriesEnabled(seriesId, false);
    }

    function test_NonPauseAuthorityCannotPause() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(TendSeriesFactory.NotPauseAuthority.selector);
        factory.setPaused(true);
    }

    function test_EmergencyAdminCanPause() public {
        vm.prank(emergencyAdmin);
        factory.setPaused(true);
        assertTrue(factory.paused());
    }

    // -- guardian rotation ----------------------------------------------------

    function test_OwnerCanTransferOwnership_NewOwnerControlsOldOwnerLocked() public {
        bytes32 seriesId = factory.createSeries(_defaultParams());
        address newOwner = address(0xCAFE1);

        factory.transferOwnership(newOwner);
        assertEq(factory.owner(), newOwner);

        vm.prank(newOwner);
        factory.setSeriesEnabled(seriesId, false);
        assertFalse(factory.isTradable(seriesId));

        vm.expectRevert(TendSeriesFactory.NotOwner.selector);
        factory.setSeriesEnabled(seriesId, true);
    }

    function test_NonOwnerCannotTransferOwnership() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(TendSeriesFactory.NotOwner.selector);
        factory.transferOwnership(address(0xCAFE1));
    }

    function test_TransferOwnershipToZeroAddressReverts() public {
        vm.expectRevert(TendSeriesFactory.InvalidAuthority.selector);
        factory.transferOwnership(address(0));
    }

    function test_OwnerCanSetEmergencyAdmin_NewAdminControlsOldAdminLocked() public {
        address newAdmin = address(0xCAFE2);
        factory.setEmergencyAdmin(newAdmin);
        assertEq(factory.emergencyAdmin(), newAdmin);

        vm.prank(newAdmin);
        factory.setPaused(true);
        assertTrue(factory.paused());

        vm.prank(emergencyAdmin);
        vm.expectRevert(TendSeriesFactory.NotPauseAuthority.selector);
        factory.setPaused(false);
    }

    function test_NonOwnerCannotSetEmergencyAdmin() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(TendSeriesFactory.NotOwner.selector);
        factory.setEmergencyAdmin(address(0xCAFE2));
    }

    function test_SetEmergencyAdminToZeroAddressReverts() public {
        vm.expectRevert(TendSeriesFactory.InvalidAuthority.selector);
        factory.setEmergencyAdmin(address(0));
    }

    // -- settlement ---------------------------------------------------------

    function _updateData(uint64 publishTime, int64 price, uint64 conf, int32 expo)
        internal
        view
        returns (bytes[] memory data)
    {
        data = new bytes[](1);
        data[0] = pyth.createPriceFeedUpdateData(feedId, price, conf, expo, price, conf, publishTime, 0);
    }

    function test_PublishSettlement_Succeeds() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);

        vm.warp(params.expiry);
        bytes[] memory data = _updateData(params.expiry, 20_405_953, 10_209, -5);
        uint256 fee = pyth.getUpdateFee(data);

        vm.deal(address(this), 1 ether);
        factory.publishSettlement{value: fee}(seriesId, data);

        TendSeriesFactory.Settlement memory settlement = factory.getSettlement(seriesId);
        assertTrue(settlement.finalized);
        assertEq(settlement.price, 20_405_953 * 1e8 / 1e5);
        assertEq(settlement.publishTime, params.expiry);
    }

    function test_PublishSettlement_RevertsBeforeExpiry() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);

        bytes[] memory data = _updateData(params.expiry, 20_405_953, 10_209, -5);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(TendSeriesFactory.SeriesNotExpired.selector);
        factory.publishSettlement{value: fee}(seriesId, data);
    }

    function test_PublishSettlement_RevertsAfterGraceWindow() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);

        vm.warp(params.expiry + params.observationWindow + params.settlementGrace + 1);
        bytes[] memory data = _updateData(params.expiry, 20_405_953, 10_209, -5);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(TendSeriesFactory.SettlementWindowClosed.selector);
        factory.publishSettlement{value: fee}(seriesId, data);
    }

    function test_PublishSettlement_RevertsOnWideConfidence() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);

        vm.warp(params.expiry);
        // conf * 10000 > price * maxConfidenceBps(2000): pick conf close to price.
        bytes[] memory data = _updateData(params.expiry, 100_000, 50_000, -5);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(address(this), 1 ether);
        vm.expectRevert(TendSeriesFactory.OracleConfidenceTooWide.selector);
        factory.publishSettlement{value: fee}(seriesId, data);
    }

    function test_PublishSettlement_OnlyOnce() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);

        vm.warp(params.expiry);
        bytes[] memory data = _updateData(params.expiry, 20_405_953, 10_209, -5);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(address(this), 1 ether);
        factory.publishSettlement{value: fee}(seriesId, data);

        vm.expectRevert(TendSeriesFactory.AlreadyFinalized.selector);
        factory.publishSettlement{value: fee}(seriesId, data);
    }

    function test_PublishSettlement_IsPermissionlessForAnyCaller() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);

        vm.warp(params.expiry);
        bytes[] memory data = _updateData(params.expiry, 20_405_953, 10_209, -5);
        uint256 fee = pyth.getUpdateFee(data);

        address rando = address(0xC0FFEE);
        vm.deal(rando, 1 ether);
        vm.prank(rando);
        factory.publishSettlement{value: fee}(seriesId, data);

        assertTrue(factory.getSettlement(seriesId).finalized);
    }

    function test_PublishSettlement_EvenWhilePaused() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);
        factory.setPaused(true);

        vm.warp(params.expiry);
        bytes[] memory data = _updateData(params.expiry, 20_405_953, 10_209, -5);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(address(this), 1 ether);
        factory.publishSettlement{value: fee}(seriesId, data);

        assertTrue(factory.getSettlement(seriesId).finalized);
    }

    // -- settlement price cherry-picking (fixed publish-time slack) ---------
    //
    // Pyth only bounds a tick's publishTime, not its freshness relative to
    // block.timestamp, and signed VAAs remain submittable indefinitely. Pre-fix,
    // publishSettlement accepted ANY tick with publishTime in
    // [expiry, expiry + observationWindow] and finalized on it permanently, so
    // whoever called publishSettlement first could choose the settlement price
    // from every tick published across the whole window (up to 1 hour at
    // MAX_OBSERVATION_WINDOW; 60s at the live product setting used by
    // web/src/lib/seriesParams.ts and scripts/lib/e2e/seed-series.ts). The fix
    // adds MAX_PUBLISH_TIME_SLACK (contracts/TendSeriesFactory.sol), a fixed
    // 15s cap on how far past expiry an accepted publishTime may be,
    // independent of and never widening past observationWindow.

    function test_PublishSettlement_CherryPickAttack_FarTickNoLongerSelectable() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams(); // observationWindow = OBS_WINDOW = 60s
        bytes32 seriesId = factory.createSeries(params);

        uint256 slack = factory.MAX_PUBLISH_TIME_SLACK();
        assertLt(slack, uint256(params.observationWindow), "test assumes slack is strictly tighter than the live 60s window");

        // Two independently-valid Pyth ticks, both inside the series' declared
        // [expiry, expiry+observationWindow] window -- exactly the "materially
        // different prices inside the window" the pre-fix contract would have
        // let a racer choose between. 100% apart, matching the worst-case
        // divergence measured on real BTC data at wide windows.
        uint64 nearTime = params.expiry; // t = expiry -- inside the new slack
        uint64 farTime = params.expiry + params.observationWindow; // t = expiry+60s -- the tick a racer would have cherry-picked pre-fix
        int64 nearPrice = 20_000_000; // ~$200.00 at expo=-5
        int64 farPrice = 40_000_000; // ~$400.00 at expo=-5 -- 100% higher

        // Sanity: both ticks really were inside the PRE-FIX acceptance window
        // (this is exactly the vulnerable rule: [expiry, expiry+observationWindow]).
        assertGe(nearTime, params.expiry);
        assertLe(farTime, params.expiry + params.observationWindow);

        // A settler can wait as long as they like before calling
        // publishSettlement (Pyth enforces no freshness bound), so both ticks
        // already exist on Hermes by the time anyone actually settles.
        vm.warp(farTime);
        vm.deal(address(this), 1 ether);

        // Post-fix: the far tick -- the one a cherry-picking racer would have
        // reached for -- is now rejected before the factory ever reads a
        // price. Pre-fix, this exact call would have succeeded and finalized
        // permanently at farPrice (2x nearPrice).
        bytes[] memory farData = _updateData(farTime, farPrice, 10_209, -5);
        uint256 farFee = pyth.getUpdateFee(farData);
        vm.expectRevert(PythErrors.PriceFeedNotFoundWithinRange.selector);
        factory.publishSettlement{value: farFee}(seriesId, farData);

        // The near tick, inside the new slack, still settles -- a prompt
        // settler retains liveness.
        bytes[] memory nearData = _updateData(nearTime, nearPrice, 10_209, -5);
        uint256 nearFee = pyth.getUpdateFee(nearData);
        factory.publishSettlement{value: nearFee}(seriesId, nearData);

        TendSeriesFactory.Settlement memory settlement = factory.getSettlement(seriesId);
        assertTrue(settlement.finalized);
        assertEq(settlement.price, uint256(uint64(nearPrice)) * 1e8 / 1e5);

        // Before the fix, a racer's choice spanned nearPrice..farPrice (100%
        // of this repro's price, i.e. up to 100% of maxPayout on a capped
        // spread whose width brackets that move -- see the report this fix
        // responds to). After the fix, farPrice is structurally unreachable:
        // the only settleable price is the one tick inside the fixed slack,
        // so the spread between what a racer could still choose from is
        // bounded by whatever a liquid feed moves in `slack` seconds, not by
        // the full observationWindow.
    }

    function test_PublishSettlement_PublishTimeSlack_AcceptsAtBoundary() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);
        uint256 slack = factory.MAX_PUBLISH_TIME_SLACK();

        vm.warp(params.expiry + params.observationWindow);
        vm.deal(address(this), 1 ether);

        bytes[] memory atBoundary = _updateData(uint64(params.expiry + slack), 20_405_953, 10_209, -5);
        uint256 fee = pyth.getUpdateFee(atBoundary);
        factory.publishSettlement{value: fee}(seriesId, atBoundary);

        assertTrue(factory.getSettlement(seriesId).finalized);
        assertEq(factory.getSettlement(seriesId).publishTime, params.expiry + slack);
    }

    function test_PublishSettlement_RevertsOnePastPublishTimeSlack() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);
        uint256 slack = factory.MAX_PUBLISH_TIME_SLACK();

        vm.warp(params.expiry + params.observationWindow);
        vm.deal(address(this), 1 ether);

        // One second past the slack boundary, but still well inside the
        // series' own (60s) observationWindow -- pre-fix this would have
        // succeeded.
        bytes[] memory onePast = _updateData(uint64(params.expiry + slack + 1), 20_405_953, 10_209, -5);
        uint256 fee = pyth.getUpdateFee(onePast);
        vm.expectRevert(PythErrors.PriceFeedNotFoundWithinRange.selector);
        factory.publishSettlement{value: fee}(seriesId, onePast);
    }

    function test_PublishSettlement_PublishTimeSlack_NeverWidensNarrowObservationWindow() public {
        // A series whose OWN observationWindow is narrower than
        // MAX_PUBLISH_TIME_SLACK must not have its acceptance window widened
        // out to the slack -- the slack only ever narrows, never widens, what
        // the series creator declared.
        uint256 slack = factory.MAX_PUBLISH_TIME_SLACK();
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        params.observationWindow = uint32(slack) - 1; // strictly narrower than the slack
        bytes32 seriesId = factory.createSeries(params);

        vm.warp(params.expiry + params.observationWindow);
        vm.deal(address(this), 1 ether);

        // publishTime is inside MAX_PUBLISH_TIME_SLACK (15s) but outside this
        // series' own narrower observationWindow (14s) -- must still revert,
        // proving the slack only narrows, never widens, what the series
        // creator declared.
        bytes[] memory pastOwnWindow =
            _updateData(uint64(params.expiry) + params.observationWindow + 1, 20_405_953, 10_209, -5);
        uint256 fee = pyth.getUpdateFee(pastOwnWindow);
        vm.expectRevert(PythErrors.PriceFeedNotFoundWithinRange.selector);
        factory.publishSettlement{value: fee}(seriesId, pastOwnWindow);
    }

    // -- refund timing --------------------------------------------------------

    function test_PublishSettlement_RejectsLaterTickEvenInsideSlack() public {
        factory = new TendSeriesFactory(owner, emergencyAdmin, IPyth(address(new UniquePythTestAdapter(pyth))));
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);
        vm.warp(params.expiry + 5);
        vm.deal(address(this), 1 ether);
        bytes[] memory data = new bytes[](1);
        // A preceding tick already exists at expiry: this later tick must not be selectable.
        data[0] = pyth.createPriceFeedUpdateData(feedId, 40_000_000, 10, -5, 40_000_000, 10, params.expiry + 5, params.expiry);
        uint256 fee = pyth.getUpdateFee(data);
        vm.expectRevert(PythErrors.PriceFeedNotFoundWithinRange.selector);
        factory.publishSettlement{value: fee}(seriesId, data);
        assertFalse(factory.getSettlement(seriesId).finalized);
        // The actual first tick still settles through the unique-only adapter.
        data[0] = pyth.createPriceFeedUpdateData(feedId, 20_000_000, 10, -5, 20_000_000, 10, params.expiry, params.expiry - 1);
        factory.publishSettlement{value: fee}(seriesId, data);
        assertEq(factory.getSettlement(seriesId).price, 20_000_000 * 1e8 / 1e5);
    }

    function test_PublishSettlement_RejectsPositivePriceRoundedToZero() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);
        vm.warp(params.expiry);
        vm.deal(address(this), 1 ether);
        bytes[] memory data = _updateData(params.expiry, 1, 0, -18);
        uint256 fee = pyth.getUpdateFee(data);
        vm.expectRevert(TendSeriesFactory.InvalidOraclePrice.selector);
        factory.publishSettlement{value: fee}(seriesId, data);
        assertFalse(factory.getSettlement(seriesId).finalized);
    }

    function test_PublishSettlement_RejectsWrongFeedFromReceiver() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);
        vm.warp(params.expiry);
        vm.deal(address(this), 1 ether);
        bytes[] memory data = _updateData(params.expiry, 1_000_000, 0, -5);
        uint256 fee = pyth.getUpdateFee(data);
        PythStructs.PriceFeed[] memory feeds = new PythStructs.PriceFeed[](1);
        feeds[0].id = bytes32(uint256(0xBAD));
        feeds[0].price = PythStructs.Price({price: 1_000_000, conf: 0, expo: -5, publishTime: params.expiry});
        vm.mockCall(address(pyth), abi.encodeWithSelector(IPyth.parsePriceFeedUpdatesUnique.selector), abi.encode(feeds));
        vm.expectRevert(TendSeriesFactory.InvalidPythFeed.selector);
        factory.publishSettlement{value: fee}(seriesId, data);
    }

    function test_PublishSettlement_RejectsEmptyReceiverResponse() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);
        vm.warp(params.expiry);
        vm.deal(address(this), 1 ether);
        bytes[] memory data = _updateData(params.expiry, 1_000_000, 0, -5);
        uint256 fee = pyth.getUpdateFee(data);
        PythStructs.PriceFeed[] memory feeds = new PythStructs.PriceFeed[](0);
        vm.mockCall(address(pyth), abi.encodeWithSelector(IPyth.parsePriceFeedUpdatesUnique.selector), abi.encode(feeds));
        vm.expectRevert(TendSeriesFactory.InvalidPythFeed.selector);
        factory.publishSettlement{value: fee}(seriesId, data);
    }

    function test_IsRefundable_FalseBeforeDeadline_TrueAfter_FalseOnceFinalized() public {
        TendSeriesFactory.CreateSeriesParams memory params = _defaultParams();
        bytes32 seriesId = factory.createSeries(params);

        assertFalse(factory.isRefundable(seriesId));

        uint256 deadline = uint256(params.expiry) + params.observationWindow + params.settlementGrace;
        vm.warp(deadline);
        assertFalse(factory.isRefundable(seriesId));

        vm.warp(deadline + 1);
        assertTrue(factory.isRefundable(seriesId));

        // Finalizing right at the deadline boundary should make it non-refundable.
        vm.warp(deadline);
        bytes[] memory data = _updateData(params.expiry, 20_405_953, 10_209, -5);
        uint256 fee = pyth.getUpdateFee(data);
        vm.deal(address(this), 1 ether);
        factory.publishSettlement{value: fee}(seriesId, data);

        vm.warp(deadline + 1);
        assertFalse(factory.isRefundable(seriesId));
    }
}
