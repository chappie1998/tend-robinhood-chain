// GENERATED FILE — do not hand-edit.
// Source: artifacts/contracts/TendSeriesFactory.sol/TendSeriesFactory.json (Hardhat compile artifact).
// Regenerate with `node web/scripts/gen-abis.mjs` after `npx hardhat compile`.

export const tendSeriesFactoryAbi = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "initialOwner",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "initialEmergencyAdmin",
        "type": "address"
      },
      {
        "internalType": "contract IPyth",
        "name": "pythContract",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "AlreadyFinalized",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InsufficientFee",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidAuthority",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidConfidence",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidExpiry",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidObservationTime",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidObservationWindow",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidOraclePrice",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidPythExponent",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidPythFeed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidSettlementGrace",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidSettlementToken",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidSymbol",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotOwner",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotPauseAuthority",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "OracleConfidenceTooWide",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "Paused",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "Reentrant",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "RefundFailed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SeriesAlreadyExists",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SeriesNotExpired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SeriesNotFound",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SettlementWindowClosed",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "bool",
        "name": "paused",
        "type": "bool"
      }
    ],
    "name": "PauseSet",
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
        "indexed": true,
        "internalType": "address",
        "name": "creator",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "pythFeedId",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "settlementToken",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "expiry",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint32",
        "name": "observationWindow",
        "type": "uint32"
      },
      {
        "indexed": false,
        "internalType": "uint32",
        "name": "settlementGrace",
        "type": "uint32"
      },
      {
        "indexed": false,
        "internalType": "uint16",
        "name": "maxConfidenceBps",
        "type": "uint16"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "symbol",
        "type": "bytes32"
      }
    ],
    "name": "SeriesCreated",
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
      }
    ],
    "name": "SeriesEnabledSet",
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
        "internalType": "uint256",
        "name": "price",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "publishTime",
        "type": "uint64"
      }
    ],
    "name": "SettlementPublished",
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
    "name": "MAX_CONFIDENCE_BPS",
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
    "name": "MAX_OBSERVATION_WINDOW",
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
    "name": "MAX_PUBLISH_TIME_SLACK",
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
    "name": "MAX_PYTH_EXPONENT_ABS",
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
    "name": "MAX_SETTLEMENT_GRACE",
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
    "name": "MIN_SERIES_LEAD",
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
    "name": "PRICE_SCALE",
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
        "components": [
          {
            "internalType": "bytes32",
            "name": "pythFeedId",
            "type": "bytes32"
          },
          {
            "internalType": "address",
            "name": "settlementToken",
            "type": "address"
          },
          {
            "internalType": "uint64",
            "name": "expiry",
            "type": "uint64"
          },
          {
            "internalType": "uint32",
            "name": "observationWindow",
            "type": "uint32"
          },
          {
            "internalType": "uint32",
            "name": "settlementGrace",
            "type": "uint32"
          },
          {
            "internalType": "uint16",
            "name": "maxConfidenceBps",
            "type": "uint16"
          },
          {
            "internalType": "bytes32",
            "name": "symbol",
            "type": "bytes32"
          }
        ],
        "internalType": "struct TendSeriesFactory.CreateSeriesParams",
        "name": "params",
        "type": "tuple"
      }
    ],
    "name": "createSeries",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "seriesId",
        "type": "bytes32"
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
            "internalType": "bytes32",
            "name": "pythFeedId",
            "type": "bytes32"
          },
          {
            "internalType": "address",
            "name": "settlementToken",
            "type": "address"
          },
          {
            "internalType": "uint64",
            "name": "expiry",
            "type": "uint64"
          },
          {
            "internalType": "uint32",
            "name": "observationWindow",
            "type": "uint32"
          },
          {
            "internalType": "uint32",
            "name": "settlementGrace",
            "type": "uint32"
          },
          {
            "internalType": "uint16",
            "name": "maxConfidenceBps",
            "type": "uint16"
          },
          {
            "internalType": "bytes32",
            "name": "symbol",
            "type": "bytes32"
          }
        ],
        "internalType": "struct TendSeriesFactory.CreateSeriesParams",
        "name": "params",
        "type": "tuple"
      }
    ],
    "name": "deriveSeriesId",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "emergencyAdmin",
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
      }
    ],
    "name": "getSeries",
    "outputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "creator",
            "type": "address"
          },
          {
            "internalType": "bytes32",
            "name": "pythFeedId",
            "type": "bytes32"
          },
          {
            "internalType": "address",
            "name": "settlementToken",
            "type": "address"
          },
          {
            "internalType": "uint64",
            "name": "expiry",
            "type": "uint64"
          },
          {
            "internalType": "uint32",
            "name": "observationWindow",
            "type": "uint32"
          },
          {
            "internalType": "uint32",
            "name": "settlementGrace",
            "type": "uint32"
          },
          {
            "internalType": "uint16",
            "name": "maxConfidenceBps",
            "type": "uint16"
          },
          {
            "internalType": "bytes32",
            "name": "symbol",
            "type": "bytes32"
          },
          {
            "internalType": "bool",
            "name": "enabled",
            "type": "bool"
          }
        ],
        "internalType": "struct ITendSeriesFactory.Series",
        "name": "",
        "type": "tuple"
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
      }
    ],
    "name": "getSettlement",
    "outputs": [
      {
        "components": [
          {
            "internalType": "bool",
            "name": "finalized",
            "type": "bool"
          },
          {
            "internalType": "uint256",
            "name": "price",
            "type": "uint256"
          },
          {
            "internalType": "uint64",
            "name": "publishTime",
            "type": "uint64"
          }
        ],
        "internalType": "struct ITendSeriesFactory.Settlement",
        "name": "",
        "type": "tuple"
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
      }
    ],
    "name": "isRefundable",
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
        "internalType": "bytes32",
        "name": "seriesId",
        "type": "bytes32"
      }
    ],
    "name": "isTradable",
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
    "inputs": [],
    "name": "owner",
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
    "name": "paused",
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
        "internalType": "bytes32",
        "name": "seriesId",
        "type": "bytes32"
      },
      {
        "internalType": "bytes[]",
        "name": "updateData",
        "type": "bytes[]"
      }
    ],
    "name": "publishSettlement",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "price",
        "type": "uint256"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "pyth",
    "outputs": [
      {
        "internalType": "contract IPyth",
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
      }
    ],
    "name": "seriesExists",
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
        "internalType": "address",
        "name": "nextEmergencyAdmin",
        "type": "address"
      }
    ],
    "name": "setEmergencyAdmin",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bool",
        "name": "nextPaused",
        "type": "bool"
      }
    ],
    "name": "setPaused",
    "outputs": [],
    "stateMutability": "nonpayable",
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
      }
    ],
    "name": "setSeriesEnabled",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "nextOwner",
        "type": "address"
      }
    ],
    "name": "transferOwnership",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;
