// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/// @title TendPriceOracle
/// @notice Admin-posted settlement prices, served through the two Pyth calls
/// TendSeriesFactory makes (`getUpdateFee` and `parsePriceFeedUpdatesUnique`,
/// plus the older `parsePriceFeedUpdates` that pre-uniqueness factories call).
///
/// It replaces MockPyth on testnets. MockPyth decodes whatever update bytes it
/// is handed and has no access control, and `publishSettlement` is callable by
/// anyone — so under MockPyth any caller could settle an expired series at a
/// price they invented, and with binary payouts take the full payout from the
/// pool. Here only the admin can write a price. The `updateData` a caller
/// passes to the factory is ignored entirely: the price returned is always the
/// one the admin posted.
///
/// @dev Trust model: the admin IS the oracle. Posts are write-once per
/// (feed, publishTime) and cannot be dated in the future, and settlement takes
/// the EARLIEST post at or after the window start — so a post cannot be
/// replaced after the fact, but the admin still chooses what to post. That is
/// acceptable for a testnet demo and nothing more; production needs an
/// authenticated source (e.g. a validator-published oracle).
contract TendPriceOracle {
    /// @notice Longest [min, max] publish-time window a query may scan.
    /// The factory asks for at most 15 seconds; this bounds the loop so no
    /// caller can make a read arbitrarily expensive.
    uint64 public constant MAX_QUERY_WINDOW = 300;

    address public admin;
    address public pendingAdmin;

    /// feedId => publishTime => price. `publishTime` is kept in the struct, and
    /// a zero `price` means "nothing posted" (posts must be strictly positive).
    mapping(bytes32 => mapping(uint64 => PythStructs.Price)) private _prices;

    event PricePosted(bytes32 indexed feedId, uint64 indexed publishTime, int64 price, uint64 conf, int32 expo);
    event AdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    error NotAdmin();
    error NotPendingAdmin();
    error ZeroAddress();
    error InvalidPrice();
    error InvalidExponent();
    error PublishTimeInFuture();
    error AlreadyPosted();
    error PriceNotPosted();
    error WindowTooWide();
    error InvalidWindow();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address initialAdmin) {
        if (initialAdmin == address(0)) revert ZeroAddress();
        admin = initialAdmin;
        emit AdminTransferred(address(0), initialAdmin);
    }

    // -- writing ---------------------------------------------------------------

    /// @notice Record the price of `feedId` observed at `publishTime`.
    /// @dev Write-once per (feed, publishTime), never in the future. `expo`
    /// follows Pyth: price x 10^expo is the USD value, within [-18, 0].
    function postPrice(bytes32 feedId, int64 price, uint64 conf, int32 expo, uint64 publishTime)
        external
        onlyAdmin
    {
        if (price <= 0) revert InvalidPrice();
        if (expo > 0 || expo < -18) revert InvalidExponent();
        if (publishTime > block.timestamp) revert PublishTimeInFuture();
        if (_prices[feedId][publishTime].price != 0) revert AlreadyPosted();

        _prices[feedId][publishTime] =
            PythStructs.Price({price: price, conf: conf, expo: expo, publishTime: publishTime});
        emit PricePosted(feedId, publishTime, price, conf, expo);
    }

    // -- the Pyth surface TendSeriesFactory calls ---------------------------------

    /// @notice Posting is paid for by the admin's own transaction; reading is free.
    function getUpdateFee(bytes[] calldata) external pure returns (uint256) {
        return 0;
    }

    /// @notice Earliest admin post in [minPublishTime, maxPublishTime] for each id.
    /// @dev `updateData` is deliberately ignored — see the contract notice.
    function parsePriceFeedUpdatesUnique(
        bytes[] calldata,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory feeds) {
        return _earliestInWindow(priceIds, minPublishTime, maxPublishTime);
    }

    /// @notice Same result as the unique variant, for factories that predate it.
    function parsePriceFeedUpdates(
        bytes[] calldata,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory feeds) {
        return _earliestInWindow(priceIds, minPublishTime, maxPublishTime);
    }

    /// @notice The post for `feedId` at exactly `publishTime` (zeroed if none).
    function priceAt(bytes32 feedId, uint64 publishTime) external view returns (PythStructs.Price memory) {
        return _prices[feedId][publishTime];
    }

    // -- admin rotation ---------------------------------------------------------------

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    // -- internals ------------------------------------------------------------------------

    function _earliestInWindow(bytes32[] calldata priceIds, uint64 minPublishTime, uint64 maxPublishTime)
        private
        view
        returns (PythStructs.PriceFeed[] memory feeds)
    {
        if (maxPublishTime < minPublishTime) revert InvalidWindow();
        if (maxPublishTime - minPublishTime > MAX_QUERY_WINDOW) revert WindowTooWide();

        feeds = new PythStructs.PriceFeed[](priceIds.length);
        for (uint256 i = 0; i < priceIds.length; i++) {
            bytes32 id = priceIds[i];
            bool found;
            // Stops AT maxPublishTime rather than testing `t <= max` then
            // incrementing, which would overflow when max is type(uint64).max.
            for (uint64 t = minPublishTime;; t++) {
                PythStructs.Price memory p = _prices[id][t];
                if (p.price != 0) {
                    feeds[i] = PythStructs.PriceFeed({id: id, price: p, emaPrice: p});
                    found = true;
                    break;
                }
                if (t == maxPublishTime) break;
            }
            if (!found) revert PriceNotPosted();
        }
    }
}
