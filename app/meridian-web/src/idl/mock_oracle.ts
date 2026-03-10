/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/mock_oracle.json`.
 */
export type MockOracle = {
  "address": "HJpHCfz1mqFFNa4ANfU8mMAZ5WoNRfo7EV1sZfEV2vZ",
  "metadata": {
    "name": "mockOracle",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Mock oracle program for Meridian devnet"
  },
  "instructions": [
    {
      "name": "initializeFeed",
      "discriminator": [
        167,
        251,
        140,
        58,
        66,
        138,
        187,
        95
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "priceFeed",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  105,
                  99,
                  101,
                  95,
                  102,
                  101,
                  101,
                  100
                ]
              },
              {
                "kind": "arg",
                "path": "ticker"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "ticker",
          "type": {
            "array": [
              "u8",
              8
            ]
          }
        }
      ]
    },
    {
      "name": "updatePrice",
      "discriminator": [
        61,
        34,
        117,
        155,
        75,
        34,
        123,
        208
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "priceFeed"
          ]
        },
        {
          "name": "priceFeed",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "price",
          "type": "u64"
        },
        {
          "name": "confidence",
          "type": "u64"
        },
        {
          "name": "timestamp",
          "type": "i64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "priceFeed",
      "discriminator": [
        189,
        103,
        252,
        23,
        152,
        35,
        243,
        156
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidAuthority",
      "msg": "Invalid authority for this price feed"
    },
    {
      "code": 6001,
      "name": "feedNotInitialized",
      "msg": "Price feed has not been initialized"
    },
    {
      "code": 6002,
      "name": "invalidPrice",
      "msg": "Price must be greater than zero"
    },
    {
      "code": 6003,
      "name": "invalidTimestamp",
      "msg": "Timestamp must be greater than zero"
    }
  ],
  "types": [
    {
      "name": "priceFeed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "ticker",
            "docs": [
              "Stock ticker (UTF-8, zero-padded to 8 bytes)"
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "price",
            "docs": [
              "Current price in USDC lamports (e.g., 200_000_000 = $200.00)"
            ],
            "type": "u64"
          },
          {
            "name": "confidence",
            "docs": [
              "Confidence band width in USDC lamports"
            ],
            "type": "u64"
          },
          {
            "name": "timestamp",
            "docs": [
              "Last update time (unix timestamp)"
            ],
            "type": "i64"
          },
          {
            "name": "authority",
            "docs": [
              "Who can update this feed"
            ],
            "type": "pubkey"
          },
          {
            "name": "isInitialized",
            "docs": [
              "Whether this feed has been initialized"
            ],
            "type": "bool"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump"
            ],
            "type": "u8"
          },
          {
            "name": "padding",
            "docs": [
              "Alignment padding"
            ],
            "type": {
              "array": [
                "u8",
                6
              ]
            }
          }
        ]
      }
    }
  ]
};
