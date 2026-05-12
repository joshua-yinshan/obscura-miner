import type { Address } from "viem";

export const CONTRACT_ADDRESS =
  (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS as Address) ??
  ("0x0000000000000000000000000000000000000000" as Address);

export const ABI = [
  // ── Views ──────────────────────────────────────────────────────────
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },

  // ── Protocol params ────────────────────────────────────────────────
  { type: "function", name: "MAX_SUPPLY", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "BASE_REWARD", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "HALVING_INTERVAL", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ADJUST_INTERVAL", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "TARGET_INTERVAL", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "EPOCH_DURATION", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MAX_MINTS_PER_BLOCK", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },

  // ── Live state ─────────────────────────────────────────────────────
  { type: "function", name: "launchTime", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "currentTarget", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalMints", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mintsInWindow", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "windowStartTime", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "currentEpoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "currentEra", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "currentReward", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mintsRemaining", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "challengeOf",
    stateMutability: "view",
    inputs: [{ name: "miner", type: "address" }],
    outputs: [{ type: "bytes32" }],
  },

  // ── Mining ─────────────────────────────────────────────────────────
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [{ name: "nonce", type: "uint256" }],
    outputs: [],
  },

  // ── Events ─────────────────────────────────────────────────────────
  {
    type: "event",
    name: "Mined",
    inputs: [
      { name: "miner", type: "address", indexed: true },
      { name: "epoch", type: "uint256", indexed: true },
      { name: "nonce", type: "uint256", indexed: false },
      { name: "reward", type: "uint256", indexed: false },
      { name: "digest", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "DifficultyAdjusted",
    inputs: [
      { name: "oldTarget", type: "uint256", indexed: false },
      { name: "newTarget", type: "uint256", indexed: false },
      { name: "actualElapsed", type: "uint256", indexed: false },
      { name: "expectedElapsed", type: "uint256", indexed: false },
    ],
  },
] as const;
