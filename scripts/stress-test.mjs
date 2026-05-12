// ─────────────────────────────────────────────────────────────────────
//  Obscura · 压力测试脚本
//  -------------------------------------------------------------------
//  起 N 个虚拟矿工，每个都用独立钱包，从水龙头领钱后并发挖矿。
//  目的：在真用户进来之前，验证整套链路（proxy / anvil / 合约 / 水龙头）
//  能扛得住目标并发量。
//
//  用法:
//    cd scripts && npm install
//    PROXY=http://localhost:3001 CONTRACT=0x5FbD... MINERS=20 DURATION_S=300 \
//      node stress-test.mjs
//
//  环境变量:
//    PROXY        proxy 根 URL (默认 http://localhost:3001)
//    CONTRACT     合约地址 (必填)
//    MINERS       并发矿工数 (默认 20)
//    DURATION_S   总测试时长秒 (默认 300 = 5 min)
//    REPORT_S     报告间隔秒 (默认 10)
// ─────────────────────────────────────────────────────────────────────

import { createPublicClient, createWalletClient, http, encodeFunctionData } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { hardhat } from "viem/chains";
import { keccak_256 } from "@noble/hashes/sha3";

const PROXY      = process.env.PROXY      || "http://localhost:3001";
const RPC        = `${PROXY}/rpc`;
const FAUCET     = `${PROXY}/faucet`;
const CONTRACT   = (process.env.CONTRACT  || "").toLowerCase();
const N_MINERS   = Number(process.env.MINERS   || 20);
const DURATION_S = Number(process.env.DURATION_S || 300);
const REPORT_S   = Number(process.env.REPORT_S || 10);

if (!/^0x[0-9a-f]{40}$/.test(CONTRACT)) {
  console.error("ERROR: 请设 CONTRACT 环境变量为 0x... 合约地址");
  process.exit(1);
}

// ─── ABI（最小集）────────────────────────────────────────────────────
const ABI = [
  { type: "function", name: "challengeOf", stateMutability: "view",
    inputs: [{ name: "miner", type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "currentTarget", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable",
    inputs: [{ name: "nonce", type: "uint256" }], outputs: [] },
];

// ─── 共享 clients ───────────────────────────────────────────────────
const publicClient = createPublicClient({
  chain: hardhat,
  transport: http(RPC, { batch: false, retryCount: 1, timeout: 15_000 }),
});

// ─── 全局统计 ───────────────────────────────────────────────────────
const stats = {
  startTime:    Date.now(),
  faucetOK:     0,
  faucetFail:   0,
  mintOK:       0,
  mintRevert:   0,
  mintNetErr:   0,
  hashAttempts: 0,
  byMiner:      new Map(), // i -> { addr, balance, mints, lastError }
};

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}m${(s % 60).toString().padStart(2, "0")}s`;
}

function formatEther18(wei) {
  const w = typeof wei === "bigint" ? wei : BigInt(wei);
  const int = w / 10n ** 18n;
  const frac = (w % 10n ** 18n).toString().padStart(18, "0").slice(0, 4);
  return `${int}.${frac}`;
}

// ─── 哈希工具 ───────────────────────────────────────────────────────
function hexToBytes(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16);
  return b;
}

function writeUint256BE(buf, off, v) {
  for (let i = 31; i >= 0; i--) {
    buf[off + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function bytesToBigBE(b) {
  let r = 0n;
  for (let i = 0; i < b.length; i++) r = (r << 8n) | BigInt(b[i]);
  return r;
}

function findNonce(challengeHex, target, startNonce = 0n) {
  const challenge = hexToBytes(challengeHex);
  const buf = new Uint8Array(64);
  buf.set(challenge, 0);
  let nonce = startNonce;
  let attempts = 0;
  while (attempts < 5_000_000) {
    writeUint256BE(buf, 32, nonce);
    const h = keccak_256(buf);
    if (bytesToBigBE(h) < target) {
      return { nonce, attempts };
    }
    nonce++;
    attempts++;
  }
  throw new Error("nonce search exceeded 5M iterations (target too tight)");
}

// ─── 单个矿工 ───────────────────────────────────────────────────────
async function runMiner(i, endsAt) {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const me = {
    i,
    addr: account.address,
    mints: 0,
    lastError: null,
    balance: "0",
  };
  stats.byMiner.set(i, me);

  // 1. 领水龙头
  try {
    const r = await fetch(`${FAUCET}?address=${account.address}`, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) {
      stats.faucetOK++;
    } else {
      stats.faucetFail++;
      me.lastError = `faucet: ${j.error || r.status}`;
      console.error(`[#${i}] 水龙头失败: ${me.lastError}`);
      return;
    }
  } catch (e) {
    stats.faucetFail++;
    me.lastError = `faucet net: ${e.message}`;
    return;
  }

  // 等区块（faucet 是同步的，但保险起见 wait 1 块）
  await sleep(500);

  const walletClient = createWalletClient({
    account,
    chain: hardhat,
    transport: http(RPC, { batch: false, retryCount: 0, timeout: 15_000 }),
  });

  let lastNonce = 0n;        // 防止同 challenge 内反复找到同一个 nonce
  let lastChallenge = "0x0"; // challenge 换了才从 0 开始重新搜

  while (Date.now() < endsAt) {
    try {
      // 2. 读 challenge + target
      const [challenge, target] = await Promise.all([
        publicClient.readContract({ address: CONTRACT, abi: ABI, functionName: "challengeOf", args: [account.address] }),
        publicClient.readContract({ address: CONTRACT, abi: ABI, functionName: "currentTarget" }),
      ]);

      // challenge 换了 → 从 0 开始；否则接着上次 nonce + 1
      const startNonce = challenge === lastChallenge ? lastNonce + 1n : 0n;
      lastChallenge = challenge;

      // 3. 找 nonce
      const t0 = Date.now();
      const { nonce, attempts } = findNonce(challenge, target, startNonce);
      lastNonce = nonce;
      stats.hashAttempts += attempts;
      const findMs = Date.now() - t0;

      // 4. 提交 mint
      try {
        const hash = await walletClient.writeContract({
          address: CONTRACT,
          abi: ABI,
          functionName: "mint",
          args: [nonce],
          gas: 250_000n,
        });
        // 5. 等确认
        const rcpt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
        if (rcpt.status === "success") {
          stats.mintOK++;
          me.mints++;
        } else {
          stats.mintRevert++;
          me.lastError = "tx reverted";
        }
      } catch (e) {
        // viem 抛 ContractFunctionExecutionError 时 e.shortMessage 可读性最好
        const msg = e?.shortMessage || e?.message || String(e);
        if (msg.includes("invalid PoW") || msg.includes("digest already used") || msg.includes("block cap")) {
          stats.mintRevert++;
          me.lastError = "tx revert: " + msg.slice(0, 80);
        } else {
          stats.mintNetErr++;
          me.lastError = "net err: " + msg.slice(0, 80);
        }
      }

      // 读余额（顺便）
      const bal = await publicClient.readContract({
        address: CONTRACT, abi: ABI, functionName: "balanceOf", args: [account.address],
      });
      me.balance = formatEther18(bal);

      // 找得太快就稍微让一下（避免每 5ms 一笔 tx 把 Anvil 怼烂）
      if (findMs < 50) await sleep(50 - findMs);
    } catch (e) {
      me.lastError = e.message?.slice(0, 80) || String(e).slice(0, 80);
      await sleep(2000);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 状态报告器 ─────────────────────────────────────────────────────
function printReport() {
  const elapsed = Date.now() - stats.startTime;
  const hps = stats.hashAttempts / (elapsed / 1000);
  console.log("─".repeat(80));
  console.log(`elapsed=${fmtDuration(elapsed)}  hashAttempts=${stats.hashAttempts.toLocaleString()}  ~${(hps / 1000).toFixed(1)} kh/s aggregate`);
  console.log(`faucet=${stats.faucetOK}/${stats.faucetOK + stats.faucetFail}  mints=${stats.mintOK} revert=${stats.mintRevert} netErr=${stats.mintNetErr}`);

  // top 5 miners
  const top = [...stats.byMiner.values()].sort((a, b) => b.mints - a.mints).slice(0, 5);
  console.log("top miners:");
  for (const m of top) {
    console.log(`  #${m.i.toString().padStart(2)} ${m.addr.slice(0, 10)}… mints=${m.mints} bal=${m.balance} ${m.lastError ? "[" + m.lastError + "]" : ""}`);
  }
}

// ─── 主流程 ─────────────────────────────────────────────────────────
async function main() {
  console.log(`obscura stress test`);
  console.log(`  proxy:    ${PROXY}`);
  console.log(`  contract: ${CONTRACT}`);
  console.log(`  miners:   ${N_MINERS}`);
  console.log(`  duration: ${DURATION_S}s`);
  console.log("");

  // 探测 proxy/anvil 通不通
  try {
    const h = await (await fetch(`${PROXY}/health`)).json();
    console.log(`proxy health: ${JSON.stringify(h)}\n`);
  } catch (e) {
    console.error(`proxy 不通: ${e.message}`);
    process.exit(2);
  }

  const endsAt = Date.now() + DURATION_S * 1000;
  const reportTimer = setInterval(printReport, REPORT_S * 1000);

  const tasks = Array.from({ length: N_MINERS }, (_, i) => runMiner(i, endsAt));
  await Promise.all(tasks);

  clearInterval(reportTimer);
  console.log("\n═══════════════════════════════════════════════════════════════════");
  console.log("最终结果:");
  printReport();
  console.log("═══════════════════════════════════════════════════════════════════");

  // 总结
  console.log("\n摘要:");
  console.log(`  完成 mints:   ${stats.mintOK}`);
  console.log(`  revert 次数:  ${stats.mintRevert}`);
  console.log(`  网络错误:     ${stats.mintNetErr}`);
  console.log(`  水龙头成功:   ${stats.faucetOK}/${N_MINERS}`);
  const successRate = stats.mintOK / Math.max(1, stats.mintOK + stats.mintRevert + stats.mintNetErr);
  console.log(`  整体成功率:   ${(successRate * 100).toFixed(1)}%`);
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
