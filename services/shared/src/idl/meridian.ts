/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/meridian.json`.
 */
export type Meridian = {
  "address": "7WuivPB111pMKvTUQy32p6w5Gt85PcjhvEkTg8UkMbth",
  "metadata": {
    "name": "meridian",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Binary stock outcome trading on Solana"
  },
  "instructions": [
    {
      "name": "adminOverrideSettlement",
      "discriminator": [
        250,
        199,
        33,
        85,
        163,
        190,
        143,
        101
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "relations": [
            "market"
          ]
        },
        {
          "name": "market",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "newSettlementPrice",
          "type": "u64"
        }
      ]
    },
    {
      "name": "adminSettle",
      "discriminator": [
        138,
        218,
        221,
        118,
        96,
        220,
        75,
        11
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "relations": [
            "market"
          ]
        },
        {
          "name": "market",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "settlementPrice",
          "type": "u64"
        }
      ]
    },
    {
      "name": "allocateOrderBook",
      "discriminator": [
        47,
        22,
        106,
        153,
        238,
        112,
        183,
        107
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "orderBook",
          "docs": [
            "Address verified in handler against derived PDA seeds."
          ],
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "marketKey",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "cancelOrder",
      "discriminator": [
        95,
        129,
        237,
        240,
        8,
        49,
        223,
        132
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "relations": [
            "market"
          ]
        },
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "orderBook",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "escrowVault",
          "docs": [
            "USDC escrow vault — refund source for USDC bids"
          ],
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "yesEscrow",
          "docs": [
            "Yes token escrow — refund source for Yes asks"
          ],
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "noEscrow",
          "docs": [
            "No token escrow — refund source for No-backed bids"
          ],
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "userUsdcAta",
          "docs": [
            "User's USDC ATA (refund dest for side=0)"
          ],
          "writable": true
        },
        {
          "name": "userYesAta",
          "docs": [
            "User's Yes ATA (refund dest for side=1)"
          ],
          "writable": true
        },
        {
          "name": "userNoAta",
          "docs": [
            "User's No ATA (refund dest for side=2)"
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "price",
          "type": "u8"
        },
        {
          "name": "orderId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "crankCancel",
      "discriminator": [
        157,
        121,
        177,
        91,
        228,
        159,
        136,
        70
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "relations": [
            "market"
          ]
        },
        {
          "name": "market"
        },
        {
          "name": "orderBook",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "escrowVault",
          "docs": [
            "USDC escrow vault — refund source for USDC bids (side=0)"
          ],
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "yesEscrow",
          "docs": [
            "Yes token escrow — refund source for Yes asks (side=1)"
          ],
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "noEscrow",
          "docs": [
            "No token escrow — refund source for No-backed bids (side=2)"
          ],
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "batchSize",
          "type": "u8"
        }
      ]
    },
    {
      "name": "createStrikeMarket",
      "discriminator": [
        21,
        162,
        50,
        119,
        68,
        218,
        221,
        35
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config"
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "ticker"
              },
              {
                "kind": "arg",
                "path": "strikePrice"
              },
              {
                "kind": "arg",
                "path": "expiryDay"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "usdcVault",
          "docs": [
            "USDC collateral vault — holds $1 × pairs minted"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "escrowVault",
          "docs": [
            "USDC escrow for bid orders (side=0)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "yesEscrow",
          "docs": [
            "Yes token escrow for ask orders (side=1)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noEscrow",
          "docs": [
            "No token escrow for No-backed bid orders (side=2)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "orderBook",
          "docs": [
            "OrderBook — ZeroCopy, pre-allocated by client due to 10KB CPI size limit.",
            "Client must create this PDA (owned by program, zeroed, correct space)",
            "before calling create_strike_market."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
                  101,
                  114,
                  95,
                  98,
                  111,
                  111,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "oracleFeed"
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
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
        },
        {
          "name": "strikePrice",
          "type": "u64"
        },
        {
          "name": "expiryDay",
          "type": "u32"
        },
        {
          "name": "marketCloseUnix",
          "type": "i64"
        },
        {
          "name": "previousClose",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initializeConfig",
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "docs": [
            "Mock USDC mint (or real USDC on mainnet)"
          ]
        },
        {
          "name": "treasury",
          "docs": [
            "Treasury USDC account owned by config PDA — receives unclaimed USDC from force-closed markets"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "oracleProgram"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "tickers",
          "type": {
            "array": [
              {
                "array": [
                  "u8",
                  8
                ]
              },
              7
            ]
          }
        },
        {
          "name": "tickerCount",
          "type": "u8"
        },
        {
          "name": "stalenessThreshold",
          "type": "u64"
        },
        {
          "name": "settlementStaleness",
          "type": "u64"
        },
        {
          "name": "confidenceBps",
          "type": "u64"
        },
        {
          "name": "oracleType",
          "type": "u8"
        }
      ]
    },
    {
      "name": "mintPair",
      "discriminator": [
        19,
        149,
        94,
        110,
        181,
        186,
        33,
        107
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "relations": [
            "market"
          ]
        },
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "yesMint",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "noMint",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "userUsdcAta",
          "docs": [
            "User's USDC token account — source of deposit"
          ],
          "writable": true
        },
        {
          "name": "userYesAta",
          "docs": [
            "User's Yes token account — created if needed. Position constraint: must be 0."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "yesMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "userNoAta",
          "docs": [
            "User's No token account — created if needed. NOT checked for balance (Buy No flow needs this)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "noMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "usdcVault",
          "docs": [
            "USDC collateral vault"
          ],
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "quantity",
          "type": "u64"
        }
      ]
    },
    {
      "name": "pause",
      "discriminator": [
        211,
        22,
        221,
        251,
        74,
        121,
        193,
        47
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true
        },
        {
          "name": "market",
          "docs": [
            "Optional: the market to pause. If not provided, pauses globally."
          ],
          "writable": true,
          "optional": true
        }
      ],
      "args": [
        {
          "name": "market",
          "type": {
            "option": "pubkey"
          }
        }
      ]
    },
    {
      "name": "placeOrder",
      "discriminator": [
        51,
        194,
        155,
        175,
        109,
        130,
        96,
        106
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "relations": [
            "market"
          ]
        },
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "orderBook",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "usdcVault",
          "docs": [
            "USDC collateral vault (for merge/burn debits)"
          ],
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "escrowVault",
          "docs": [
            "USDC escrow for bid orders"
          ],
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "yesEscrow",
          "docs": [
            "Yes token escrow for ask orders"
          ],
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "noEscrow",
          "docs": [
            "No token escrow for No-backed bid orders"
          ],
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "yesMint",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "noMint",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "userUsdcAta",
          "docs": [
            "User's USDC ATA (escrow source for side=0, payout dest for merge/burn)"
          ],
          "writable": true
        },
        {
          "name": "userYesAta",
          "docs": [
            "User's Yes ATA (escrow source for side=1, receipt for swap fills)"
          ],
          "writable": true
        },
        {
          "name": "userNoAta",
          "docs": [
            "User's No ATA (escrow source for side=2, position constraint for side=0)"
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "side",
          "type": "u8"
        },
        {
          "name": "price",
          "type": "u8"
        },
        {
          "name": "quantity",
          "type": "u64"
        },
        {
          "name": "orderType",
          "type": "u8"
        },
        {
          "name": "maxFills",
          "type": "u8"
        }
      ]
    },
    {
      "name": "redeem",
      "discriminator": [
        184,
        12,
        86,
        149,
        70,
        196,
        97,
        225
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "relations": [
            "market"
          ]
        },
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "yesMint",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "noMint",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "usdcVault",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "userUsdcAta",
          "docs": [
            "User's USDC ATA — payout destination"
          ],
          "writable": true
        },
        {
          "name": "userYesAta",
          "docs": [
            "User's Yes ATA"
          ],
          "writable": true
        },
        {
          "name": "userNoAta",
          "docs": [
            "User's No ATA"
          ],
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "mode",
          "type": "u8"
        },
        {
          "name": "quantity",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setMarketAlt",
      "discriminator": [
        10,
        1,
        219,
        164,
        249,
        245,
        200,
        246
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "relations": [
            "market"
          ]
        },
        {
          "name": "market",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "altAddress",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "settleMarket",
      "discriminator": [
        193,
        153,
        95,
        216,
        166,
        6,
        144,
        217
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "relations": [
            "market"
          ]
        },
        {
          "name": "market",
          "writable": true
        },
        {
          "name": "oracleFeed",
          "relations": [
            "market"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "unpause",
      "discriminator": [
        169,
        144,
        4,
        38,
        10,
        141,
        188,
        255
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true
        },
        {
          "name": "market",
          "docs": [
            "Optional: the market to unpause. If not provided, unpauses globally."
          ],
          "writable": true,
          "optional": true
        }
      ],
      "args": [
        {
          "name": "market",
          "type": {
            "option": "pubkey"
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "globalConfig",
      "discriminator": [
        149,
        8,
        156,
        202,
        160,
        252,
        176,
        217
      ]
    },
    {
      "name": "orderBook",
      "discriminator": [
        55,
        230,
        125,
        218,
        149,
        39,
        65,
        248
      ]
    },
    {
      "name": "strikeMarket",
      "discriminator": [
        109,
        109,
        58,
        228,
        193,
        219,
        99,
        7
      ]
    }
  ],
  "events": [
    {
      "name": "crankCancelEvent",
      "discriminator": [
        180,
        201,
        73,
        249,
        141,
        69,
        0,
        178
      ]
    },
    {
      "name": "fillEvent",
      "discriminator": [
        13,
        89,
        41,
        228,
        105,
        178,
        45,
        112
      ]
    },
    {
      "name": "settlementEvent",
      "discriminator": [
        48,
        132,
        218,
        111,
        54,
        173,
        61,
        129
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Non-admin calling admin-only instruction"
    },
    {
      "code": 6001,
      "name": "invalidAuthority",
      "msg": "Oracle update from non-authority wallet"
    },
    {
      "code": 6002,
      "name": "signerMismatch",
      "msg": "Transaction signer doesn't match expected account owner"
    },
    {
      "code": 6010,
      "name": "configAlreadyInitialized",
      "msg": "GlobalConfig has already been initialized"
    },
    {
      "code": 6011,
      "name": "oracleFeedAlreadyInitialized",
      "msg": "Oracle feed for this ticker has already been initialized"
    },
    {
      "code": 6012,
      "name": "invalidTicker",
      "msg": "Ticker not in GlobalConfig tickers list"
    },
    {
      "code": 6013,
      "name": "invalidMarketCloseTime",
      "msg": "Market close time is in the past"
    },
    {
      "code": 6014,
      "name": "invalidStrikePrice",
      "msg": "Strike price cannot be zero"
    },
    {
      "code": 6015,
      "name": "invalidStalenessThreshold",
      "msg": "Staleness threshold cannot be zero"
    },
    {
      "code": 6016,
      "name": "invalidConfidenceThreshold",
      "msg": "Confidence bps must be between 1 and 10000"
    },
    {
      "code": 6020,
      "name": "marketAlreadySettled",
      "msg": "Market has already been settled"
    },
    {
      "code": 6021,
      "name": "marketNotSettled",
      "msg": "Market has not been settled"
    },
    {
      "code": 6022,
      "name": "marketPaused",
      "msg": "Market or global trading is paused"
    },
    {
      "code": 6023,
      "name": "alreadyPaused",
      "msg": "Target is already paused"
    },
    {
      "code": 6024,
      "name": "notPaused",
      "msg": "Target is not paused"
    },
    {
      "code": 6025,
      "name": "marketClosed",
      "msg": "Market has been closed — use treasury_redeem"
    },
    {
      "code": 6030,
      "name": "invalidMint",
      "msg": "Token account mint doesn't match expected mint"
    },
    {
      "code": 6031,
      "name": "invalidVault",
      "msg": "Vault account doesn't match market's stored vault"
    },
    {
      "code": 6032,
      "name": "invalidEscrow",
      "msg": "Escrow account doesn't match market's stored escrow"
    },
    {
      "code": 6033,
      "name": "invalidOrderBook",
      "msg": "Order book doesn't match market's stored order book"
    },
    {
      "code": 6034,
      "name": "invalidMarket",
      "msg": "Market PDA doesn't match order book's stored market"
    },
    {
      "code": 6035,
      "name": "accountNotInitialized",
      "msg": "Required account has not been initialized"
    },
    {
      "code": 6036,
      "name": "invalidProgramId",
      "msg": "CPI target doesn't match expected program"
    },
    {
      "code": 6037,
      "name": "insufficientAccounts",
      "msg": "Not enough remaining_accounts for fill settlement"
    },
    {
      "code": 6040,
      "name": "oracleStale",
      "msg": "Oracle price is stale — exceeds staleness threshold"
    },
    {
      "code": 6041,
      "name": "oracleConfidenceTooWide",
      "msg": "Oracle confidence band is too wide"
    },
    {
      "code": 6042,
      "name": "oracleNotInitialized",
      "msg": "Oracle price feed has not been initialized"
    },
    {
      "code": 6043,
      "name": "oraclePriceInvalid",
      "msg": "Oracle price is zero or invalid"
    },
    {
      "code": 6044,
      "name": "oracleProgramMismatch",
      "msg": "Oracle program ID doesn't match GlobalConfig"
    },
    {
      "code": 6050,
      "name": "insufficientBalance",
      "msg": "Insufficient balance to cover order or mint deposit"
    },
    {
      "code": 6051,
      "name": "orderBookFull",
      "msg": "All order slots at this price level are full"
    },
    {
      "code": 6052,
      "name": "invalidPrice",
      "msg": "Price must be between 1 and 99"
    },
    {
      "code": 6053,
      "name": "invalidQuantity",
      "msg": "Quantity must be at least 1 token (1_000_000 lamports)"
    },
    {
      "code": 6054,
      "name": "orderNotFound",
      "msg": "Order not found at specified price level and order ID"
    },
    {
      "code": 6055,
      "name": "orderNotOwned",
      "msg": "Cannot cancel someone else's order"
    },
    {
      "code": 6056,
      "name": "noFillsAvailable",
      "msg": "No matching orders available for market order"
    },
    {
      "code": 6057,
      "name": "invalidOrderType",
      "msg": "Order type must be Market (0) or Limit (1)"
    },
    {
      "code": 6058,
      "name": "invalidSide",
      "msg": "Order side must be 0 (Buy Yes), 1 (Sell Yes), or 2 (Sell No)"
    },
    {
      "code": 6059,
      "name": "conflictingPosition",
      "msg": "Conflicting position — cannot hold both Yes and No tokens"
    },
    {
      "code": 6060,
      "name": "vaultBalanceMismatch",
      "msg": "Vault balance doesn't match (total_minted - total_redeemed) — invariant violation"
    },
    {
      "code": 6061,
      "name": "mintSupplyMismatch",
      "msg": "Yes mint supply != No mint supply — invariant violation"
    },
    {
      "code": 6062,
      "name": "insufficientVaultBalance",
      "msg": "Vault cannot cover redemption payout"
    },
    {
      "code": 6063,
      "name": "tokenTransferFailed",
      "msg": "SPL token transfer failed"
    },
    {
      "code": 6064,
      "name": "tokenMintFailed",
      "msg": "SPL token mint_to failed"
    },
    {
      "code": 6065,
      "name": "tokenBurnFailed",
      "msg": "SPL token burn failed"
    },
    {
      "code": 6066,
      "name": "ataCreationFailed",
      "msg": "Associated token account creation failed"
    },
    {
      "code": 6070,
      "name": "settlementTooEarly",
      "msg": "Settlement too early — market has not closed yet"
    },
    {
      "code": 6071,
      "name": "adminSettleTooEarly",
      "msg": "Admin settle too early — must wait 1 hour after market close"
    },
    {
      "code": 6072,
      "name": "overrideWindowExpired",
      "msg": "Override window has expired — outcome is final"
    },
    {
      "code": 6074,
      "name": "invalidOutcome",
      "msg": "Invalid outcome value"
    },
    {
      "code": 6075,
      "name": "maxOverridesExceeded",
      "msg": "Maximum override count (3) exceeded — outcome is final"
    },
    {
      "code": 6080,
      "name": "redemptionBlockedOverride",
      "msg": "Redemption blocked during override window — try again after deadline"
    },
    {
      "code": 6081,
      "name": "noTokensToRedeem",
      "msg": "No tokens to redeem"
    },
    {
      "code": 6082,
      "name": "invalidRedemptionMode",
      "msg": "Invalid redemption mode"
    },
    {
      "code": 6090,
      "name": "crankNotNeeded",
      "msg": "Order book is already empty — crank not needed"
    },
    {
      "code": 6100,
      "name": "arithmeticOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6101,
      "name": "divisionByZero",
      "msg": "Division by zero"
    },
    {
      "code": 6110,
      "name": "closeMarketNotSettled",
      "msg": "Cannot close an unsettled market"
    },
    {
      "code": 6111,
      "name": "closeMarketOverrideActive",
      "msg": "Cannot close market while override window is active"
    },
    {
      "code": 6112,
      "name": "closeMarketOrderBookNotEmpty",
      "msg": "Cannot close market with resting orders — run crank_cancel first"
    },
    {
      "code": 6113,
      "name": "closeMarketGracePeriodActive",
      "msg": "Cannot partially close before 90-day grace period"
    },
    {
      "code": 6114,
      "name": "invalidOracleType",
      "msg": "Oracle type flag not recognized"
    },
    {
      "code": 6115,
      "name": "pythFeedMismatch",
      "msg": "Pyth price feed ID doesn't match expected stock"
    },
    {
      "code": 6116,
      "name": "marketNotClosed",
      "msg": "Market has not been closed — use standard redeem"
    },
    {
      "code": 6117,
      "name": "mintSupplyNotZero",
      "msg": "Cannot cleanup market — tokens still outstanding"
    },
    {
      "code": 6118,
      "name": "noTreasuryFunds",
      "msg": "Treasury has insufficient USDC to cover redemption"
    },
    {
      "code": 6120,
      "name": "altAlreadySet",
      "msg": "Market ALT address has already been set"
    }
  ],
  "types": [
    {
      "name": "crankCancelEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "cancelledCount",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "fillEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "taker",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u8"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "makerSide",
            "docs": [
              "0=USDC bid, 1=Yes ask, 2=No-backed bid"
            ],
            "type": "u8"
          },
          {
            "name": "takerSide",
            "docs": [
              "0=USDC bid, 1=Yes ask, 2=No-backed bid"
            ],
            "type": "u8"
          },
          {
            "name": "isMerge",
            "docs": [
              "True if fill was a merge/burn (No-backed bid matched Yes ask)"
            ],
            "type": "bool"
          },
          {
            "name": "makerOrderId",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "globalConfig",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "docs": [
              "Admin authority"
            ],
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "docs": [
              "Mock USDC mint on devnet (real USDC on mainnet)"
            ],
            "type": "pubkey"
          },
          {
            "name": "oracleProgram",
            "docs": [
              "Mock oracle program ID"
            ],
            "type": "pubkey"
          },
          {
            "name": "stalenessThreshold",
            "docs": [
              "Max oracle age for general ops (default 60s)"
            ],
            "type": "u64"
          },
          {
            "name": "settlementStaleness",
            "docs": [
              "Max oracle age for settlement (default 120s)"
            ],
            "type": "u64"
          },
          {
            "name": "confidenceBps",
            "docs": [
              "Max confidence band as basis points of price (default 50 = 0.5%)"
            ],
            "type": "u64"
          },
          {
            "name": "isPaused",
            "docs": [
              "Global pause flag"
            ],
            "type": "bool"
          },
          {
            "name": "oracleType",
            "docs": [
              "Oracle type: 0=Mock, 1=Pyth"
            ],
            "type": "u8"
          },
          {
            "name": "tickers",
            "docs": [
              "Supported tickers (7 MAG7, padded to 8 bytes each)"
            ],
            "type": {
              "array": [
                {
                  "array": [
                    "u8",
                    8
                  ]
                },
                7
              ]
            }
          },
          {
            "name": "tickerCount",
            "docs": [
              "Number of active tickers"
            ],
            "type": "u8"
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
                4
              ]
            }
          }
        ]
      }
    },
    {
      "name": "orderBook",
      "docs": [
        "The full order book — one per market. ZeroCopy for efficient on-chain access.",
        "",
        "bytemuck requires manual Pod/Zeroable impls for arrays > 64 elements."
      ],
      "serialization": "bytemuckunsafe",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "docs": [
              "Parent market"
            ],
            "type": "pubkey"
          },
          {
            "name": "nextOrderId",
            "docs": [
              "Monotonically incrementing order ID counter"
            ],
            "type": "u64"
          },
          {
            "name": "levels",
            "docs": [
              "99 price levels (index 0 = price 1, index 98 = price 99)"
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "priceLevel"
                  }
                },
                99
              ]
            }
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
              "Trailing alignment padding"
            ],
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          }
        ]
      }
    },
    {
      "name": "orderSlot",
      "docs": [
        "A single order slot in the order book"
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "docs": [
              "Order placer"
            ],
            "type": "pubkey"
          },
          {
            "name": "orderId",
            "docs": [
              "Unique ID from next_order_id"
            ],
            "type": "u64"
          },
          {
            "name": "quantity",
            "docs": [
              "Remaining quantity (token lamports)"
            ],
            "type": "u64"
          },
          {
            "name": "originalQuantity",
            "docs": [
              "Original quantity (for fill tracking)"
            ],
            "type": "u64"
          },
          {
            "name": "side",
            "docs": [
              "0=USDC bid (Buy Yes), 1=Yes ask (Sell Yes), 2=No-backed bid (Sell No)"
            ],
            "type": "u8"
          },
          {
            "name": "sidePadding",
            "docs": [
              "Padding for alignment before i64 timestamp"
            ],
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          },
          {
            "name": "timestamp",
            "docs": [
              "Clock::get() at placement"
            ],
            "type": "i64"
          },
          {
            "name": "isActive",
            "docs": [
              "0 = slot is empty/cancelled, 1 = active"
            ],
            "type": "u8"
          },
          {
            "name": "padding",
            "docs": [
              "Trailing alignment padding"
            ],
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          }
        ]
      }
    },
    {
      "name": "priceLevel",
      "docs": [
        "A price level containing up to MAX_ORDERS_PER_LEVEL orders"
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "orders",
            "docs": [
              "Order slots at this price"
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "orderSlot"
                  }
                },
                16
              ]
            }
          },
          {
            "name": "count",
            "docs": [
              "Number of active orders at this level"
            ],
            "type": "u8"
          },
          {
            "name": "padding",
            "docs": [
              "Trailing alignment padding"
            ],
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          }
        ]
      }
    },
    {
      "name": "settlementEvent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "ticker",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "strikePrice",
            "type": "u64"
          },
          {
            "name": "settlementPrice",
            "type": "u64"
          },
          {
            "name": "outcome",
            "docs": [
              "1=YesWins, 2=NoWins"
            ],
            "type": "u8"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "strikeMarket",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "config",
            "docs": [
              "Parent GlobalConfig"
            ],
            "type": "pubkey"
          },
          {
            "name": "yesMint",
            "docs": [
              "Yes token mint"
            ],
            "type": "pubkey"
          },
          {
            "name": "noMint",
            "docs": [
              "No token mint"
            ],
            "type": "pubkey"
          },
          {
            "name": "usdcVault",
            "docs": [
              "USDC collateral vault (holds $1 × pairs minted)"
            ],
            "type": "pubkey"
          },
          {
            "name": "escrowVault",
            "docs": [
              "USDC escrow for bid orders (side=0)"
            ],
            "type": "pubkey"
          },
          {
            "name": "yesEscrow",
            "docs": [
              "Yes token escrow for ask orders (side=1)"
            ],
            "type": "pubkey"
          },
          {
            "name": "noEscrow",
            "docs": [
              "No token escrow for No-backed bid orders (side=2)"
            ],
            "type": "pubkey"
          },
          {
            "name": "orderBook",
            "docs": [
              "OrderBook account"
            ],
            "type": "pubkey"
          },
          {
            "name": "oracleFeed",
            "docs": [
              "PriceFeed oracle account"
            ],
            "type": "pubkey"
          },
          {
            "name": "strikePrice",
            "docs": [
              "Strike price in USDC lamports (e.g., 680_000_000 = $680.00)"
            ],
            "type": "u64"
          },
          {
            "name": "marketCloseUnix",
            "docs": [
              "UTC timestamp for 4 PM ET on this trading day"
            ],
            "type": "i64"
          },
          {
            "name": "totalMinted",
            "docs": [
              "Total pairs minted (in token lamports)"
            ],
            "type": "u64"
          },
          {
            "name": "totalRedeemed",
            "docs": [
              "Total pairs redeemed"
            ],
            "type": "u64"
          },
          {
            "name": "settlementPrice",
            "docs": [
              "Oracle price at settlement (0 if unsettled)"
            ],
            "type": "u64"
          },
          {
            "name": "previousClose",
            "docs": [
              "Reference price for display (previous close)"
            ],
            "type": "u64"
          },
          {
            "name": "settledAt",
            "docs": [
              "Settlement timestamp (0 if unsettled)"
            ],
            "type": "i64"
          },
          {
            "name": "overrideDeadline",
            "docs": [
              "settled_at + 3600; admin can override until this time. 0 if unsettled."
            ],
            "type": "i64"
          },
          {
            "name": "altAddress",
            "docs": [
              "Address Lookup Table for this market (set post-creation via set_market_alt)"
            ],
            "type": "pubkey"
          },
          {
            "name": "ticker",
            "docs": [
              "Stock ticker (UTF-8, zero-padded)"
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "isSettled",
            "docs": [
              "Whether market has been settled"
            ],
            "type": "bool"
          },
          {
            "name": "outcome",
            "docs": [
              "0=unsettled, 1=YesWins, 2=NoWins"
            ],
            "type": "u8"
          },
          {
            "name": "isPaused",
            "docs": [
              "Per-market pause"
            ],
            "type": "bool"
          },
          {
            "name": "isClosed",
            "docs": [
              "True after partial close_market (Phase 6)"
            ],
            "type": "bool"
          },
          {
            "name": "overrideCount",
            "docs": [
              "Number of overrides used (max 3)"
            ],
            "type": "u8"
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
                2
              ]
            }
          }
        ]
      }
    }
  ]
};
