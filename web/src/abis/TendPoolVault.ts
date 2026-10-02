// GENERATED FILE — do not hand-edit.
// Source: artifacts/contracts/TendPoolVault.sol/TendPoolVault.json (Hardhat compile artifact).
// Regenerate with `node web/scripts/gen-abis.mjs` after `npx hardhat compile`.

export const tendPoolVaultAbi = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "factory_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "asset_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "initialManager",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "initialQuoteAuthority",
        "type": "address"
      },
      {
        "internalType": "uint16",
        "name": "initialMaxUtilizationBps",
        "type": "uint16"
      },
      {
        "internalType": "uint16",
        "name": "initialMaxPositionBps",
        "type": "uint16"
      },
      {
        "internalType": "uint16",
        "name": "initialFeeBps",
        "type": "uint16"
      },
      {
        "internalType": "address",
        "name": "initialFeeRecipient",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "AlreadyFilled",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AlreadySettled",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "BadSignature",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "BidExceedsEscrow",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "CollateralMismatch",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "DeadlineExpired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "DepositTooSmall",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "FeeTooHigh",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InsufficientLiquidity",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidAmount",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidAuthority",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidBuyer",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidDirection",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidLastTradeCutoff",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidPoolRiskLimits",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidPoolShares",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidWidth",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LastTradeCutoffReached",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotFinalized",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotManager",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "PoolHasOpenPositions",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "PoolInsolvent",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "PoolPositionLimitExceeded",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "PoolUninitialized",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "PoolUtilizationExceeded",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "PositionNotFound",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "QuoteExpired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "Reentrant",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SeriesExpired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SeriesNotAuthorized",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SeriesNotFound",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SeriesNotTradable",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SeriesSettlementTokenMismatch",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SettlementWindowOpen",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SlippageExceeded",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TokenTransferFailed",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "provider",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "shares",
        "type": "uint256"
      }
    ],
    "name": "LiquidityDeposited",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "provider",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "shares",
        "type": "uint256"
      }
    ],
    "name": "LiquidityWithdrawn",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "previousManager",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "newManager",
        "type": "address"
      }
    ],
    "name": "ManagerTransferred",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "positionId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "seriesId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "buyer",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "nonce",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "premium",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "maxPayout",
        "type": "uint256"
      }
    ],
    "name": "PoolQuoteFilled",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "quoteAuthority",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint16",
        "name": "maxUtilizationBps",
        "type": "uint16"
      },
      {
        "indexed": false,
        "internalType": "uint16",
        "name": "maxPositionBps",
        "type": "uint16"
      },
      {
        "indexed": false,
        "internalType": "uint16",
        "name": "feeBps",
        "type": "uint16"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "feeRecipient",
        "type": "address"
      }
    ],
    "name": "PoolUpdated",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "positionId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "seller",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "bid",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "poolAmount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "fee",
        "type": "uint256"
      }
    ],
    "name": "PositionClosed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "positionId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "premium",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "collateral",
        "type": "uint256"
      }
    ],
    "name": "PositionRefunded",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "positionId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "settlementPrice",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "payout",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "poolAmount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "fee",
        "type": "uint256"
      }
    ],
    "name": "PositionSettled",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "seriesId",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "enabled",
        "type": "bool"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "lastTradeAt",
        "type": "uint64"
      }
    ],
    "name": "SeriesAuthorized",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "BPS_DENOMINATOR",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "CLOSE_QUOTE_TYPEHASH",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_FEE_BPS",
    "outputs": [
      {
        "internalType": "uint16",
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MIN_TRADE_LEAD",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "POOL_QUOTE_TYPEHASH",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "asset",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "seriesId",
        "type": "bytes32"
      },
      {
        "internalType": "bool",
        "name": "enabled",
        "type": "bool"
      },
      {
        "internalType": "uint64",
        "name": "lastTradeAt",
        "type": "uint64"
      }
    ],
    "name": "authorizeSeries",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "uint16",
        "name": "bps",
        "type": "uint16"
      }
    ],
    "name": "calculateBpsLimit",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "totalSharesValue",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "totalAssetsValue",
        "type": "uint256"
      }
    ],
    "name": "calculateDepositShares",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "premium",
        "type": "uint256"
      },
      {
        "internalType": "uint16",
        "name": "feeBps_",
        "type": "uint16"
      }
    ],
    "name": "calculateFee",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint8",
        "name": "direction",
        "type": "uint8"
      },
      {
        "internalType": "uint256",
        "name": "strike",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "width",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "settlementPrice",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "maxPayout",
        "type": "uint256"
      }
    ],
    "name": "calculatePayout",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "shares",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "totalSharesValue",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "totalAssetsValue",
        "type": "uint256"
      }
    ],
    "name": "calculateWithdrawAmount",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "positionId",
            "type": "uint256"
          },
          {
            "internalType": "uint128",
            "name": "bid",
            "type": "uint128"
          },
          {
            "internalType": "uint64",
            "name": "quoteExpiry",
            "type": "uint64"
          },
          {
            "internalType": "address",
            "name": "seller",
            "type": "address"
          }
        ],
        "internalType": "struct TendPoolVault.CloseQuote",
        "name": "quote",
        "type": "tuple"
      },
      {
        "internalType": "bytes",
        "name": "signature",
        "type": "bytes"
      }
    ],
    "name": "closePosition",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "bid",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minSharesOut",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "deadline",
        "type": "uint256"
      }
    ],
    "name": "deposit",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "shares",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "domainSeparator",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "escrowedPremium",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "factory",
    "outputs": [
      {
        "internalType": "contract ITendSeriesFactory",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "feeBps",
    "outputs": [
      {
        "internalType": "uint16",
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "feeRecipient",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          },
          {
            "internalType": "uint8",
            "name": "direction",
            "type": "uint8"
          },
          {
            "internalType": "uint128",
            "name": "strike",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "width",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "premium",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "maxPayout",
            "type": "uint128"
          },
          {
            "internalType": "uint64",
            "name": "quoteExpiry",
            "type": "uint64"
          },
          {
            "internalType": "bytes32",
            "name": "seriesId",
            "type": "bytes32"
          },
          {
            "internalType": "address",
            "name": "buyer",
            "type": "address"
          }
        ],
        "internalType": "struct TendPoolVault.PoolQuote",
        "name": "quote",
        "type": "tuple"
      },
      {
        "internalType": "bytes",
        "name": "signature",
        "type": "bytes"
      }
    ],
    "name": "fillPoolQuote",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "positionId",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "positionId",
            "type": "uint256"
          },
          {
            "internalType": "uint128",
            "name": "bid",
            "type": "uint128"
          },
          {
            "internalType": "uint64",
            "name": "quoteExpiry",
            "type": "uint64"
          },
          {
            "internalType": "address",
            "name": "seller",
            "type": "address"
          }
        ],
        "internalType": "struct TendPoolVault.CloseQuote",
        "name": "quote",
        "type": "tuple"
      }
    ],
    "name": "hashCloseQuote",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          },
          {
            "internalType": "uint8",
            "name": "direction",
            "type": "uint8"
          },
          {
            "internalType": "uint128",
            "name": "strike",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "width",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "premium",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "maxPayout",
            "type": "uint128"
          },
          {
            "internalType": "uint64",
            "name": "quoteExpiry",
            "type": "uint64"
          },
          {
            "internalType": "bytes32",
            "name": "seriesId",
            "type": "bytes32"
          },
          {
            "internalType": "address",
            "name": "buyer",
            "type": "address"
          }
        ],
        "internalType": "struct TendPoolVault.PoolQuote",
        "name": "quote",
        "type": "tuple"
      }
    ],
    "name": "hashQuote",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "lockedCollateral",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "manager",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "maxPositionBps",
    "outputs": [
      {
        "internalType": "uint16",
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "maxUtilizationBps",
    "outputs": [
      {
        "internalType": "uint16",
        "name": "",
        "type": "uint16"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "nextPositionId",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "openPositions",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "name": "positions",
    "outputs": [
      {
        "internalType": "address",
        "name": "buyer",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "seriesId",
        "type": "bytes32"
      },
      {
        "internalType": "uint8",
        "name": "direction",
        "type": "uint8"
      },
      {
        "internalType": "uint128",
        "name": "strike",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "width",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "premium",
        "type": "uint128"
      },
      {
        "internalType": "uint128",
        "name": "maxPayout",
        "type": "uint128"
      },
      {
        "internalType": "uint16",
        "name": "feeBps",
        "type": "uint16"
      },
      {
        "internalType": "bool",
        "name": "settled",
        "type": "bool"
      },
      {
        "internalType": "bool",
        "name": "closed",
        "type": "bool"
      },
      {
        "internalType": "uint128",
        "name": "closeBid",
        "type": "uint128"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "quoteAuthority",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "positionId",
        "type": "uint256"
      }
    ],
    "name": "refundPoolPosition",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "name": "seriesAuth",
    "outputs": [
      {
        "internalType": "bool",
        "name": "enabled",
        "type": "bool"
      },
      {
        "internalType": "uint64",
        "name": "lastTradeAt",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "positionId",
        "type": "uint256"
      }
    ],
    "name": "settlePoolPosition",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "payout",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "sharesOf",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "totalAssets",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "totalShares",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "nextManager",
        "type": "address"
      }
    ],
    "name": "transferManager",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "nextQuoteAuthority",
        "type": "address"
      },
      {
        "internalType": "uint16",
        "name": "nextMaxUtilizationBps",
        "type": "uint16"
      },
      {
        "internalType": "uint16",
        "name": "nextMaxPositionBps",
        "type": "uint16"
      },
      {
        "internalType": "uint16",
        "name": "nextFeeBps",
        "type": "uint16"
      },
      {
        "internalType": "address",
        "name": "nextFeeRecipient",
        "type": "address"
      }
    ],
    "name": "updatePool",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "name": "usedNonces",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "shares",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minAmountOut",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "deadline",
        "type": "uint256"
      }
    ],
    "name": "withdraw",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;
