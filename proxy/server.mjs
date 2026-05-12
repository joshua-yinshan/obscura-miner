// ─────────────────────────────────────────────────────────────────────
//  Obscura Proxy + Faucet
//  -------------------------------------------------------------------
//  把 Anvil 用安全的方式暴露给公网测试用户：
//   - /rpc      ← JSON-RPC 反向代理，**白名单方法**，屏蔽 anvil_/hardhat_/debug_
//   - /faucet   ← 用 anvil_setBalance 给来访钱包打 1 ETH（受速率限制）
//   - /stats    ← 实时统计（mints / supply / 在线钱包）
//   - /health   ← 健康检查
//
//  默认监听 :3001。Anvil 必须在同机 :8545 跑（不对外）。
// ─────────────────────────────────────────────────────────────────────

import express from "express";
import cors from "cors";

const PORT       = Number(process.env.PORT || 3001);
const ANVIL_URL  = process.env.ANVIL_URL  || "http://127.0.0.1:8545";
const CONTRACT   = (process.env.CONTRACT_ADDRESS || "").toLowerCase();
const FAUCET_AMT = process.env.FAUCET_WEI || "1000000000000000000"; // 1 ETH

// ─── 速率限制（内存版，单实例够用）──────────────────────────────────
const FAUCET_COOLDOWN_MS = Number(process.env.FAUCET_COOLDOWN_MS || 60 * 60 * 1000);  // 1h
const IP_LIMIT_WINDOW    = Number(process.env.IP_LIMIT_WINDOW    || 60 * 1000);       // 1 min
const IP_LIMIT_MAX       = Number(process.env.IP_LIMIT_MAX       || 1200);            // 每 IP 每分钟 1200 次
//   依据：单矿工每秒 ~3-5 RPC 调用，1 分钟 ~200。1200/min 撑得起 5-6 个同 IP 矿工并发，
//   且公网用户大多 IP 不同，单 IP 给 1200 已经很宽松。压测时可调更高。

const lastFaucetAt = new Map();   // addr -> timestamp
const ipBucket     = new Map();   // ip   -> { count, resetAt }
const seenAddrs    = new Set();   // 唯一地址统计

// ─── RPC 方法白名单 ──────────────────────────────────────────────────
// 公开 standard JSON-RPC。屏蔽所有可破坏链状态的 admin 方法。
const ALLOWED_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_sendRawTransaction",
  "eth_getLogs",
  "eth_syncing",
  "eth_accounts",
  "eth_subscribe",
  "eth_unsubscribe",
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_uninstallFilter",
  "eth_getFilterChanges",
  "eth_getFilterLogs",
  "net_version",
  "net_listening",
  "net_peerCount",
  "web3_clientVersion",
  "web3_sha3",
]);

// 严禁通过 /rpc 暴露的方法（即便不在白名单也会被自然挡掉，但显式列出便于审计）
const BLOCKED_METHODS = new Set([
  "anvil_setBalance",
  "anvil_setCode",
  "anvil_setNonce",
  "anvil_setStorageAt",
  "anvil_impersonateAccount",
  "anvil_stopImpersonatingAccount",
  "anvil_setChainId",
  "anvil_reset",
  "anvil_mine",
  "anvil_setNextBlockTimestamp",
  "anvil_setBlockGasLimit",
  "anvil_dumpState",
  "anvil_loadState",
  "anvil_setLoggingEnabled",
  "evm_setAutomine",
  "evm_setIntervalMining",
  "evm_mine",
  "evm_revert",
  "evm_snapshot",
  "evm_increaseTime",
  "evm_setTime",
  "evm_setBlockTimestampInterval",
  "evm_removeBlockTimestampInterval",
  "evm_setNextBlockTimestamp",
  "hardhat_impersonateAccount",
  "hardhat_stopImpersonatingAccount",
  "hardhat_setBalance",
  "hardhat_setCode",
  "hardhat_setStorageAt",
  "hardhat_reset",
  "hardhat_mine",
  "hardhat_setNextBlockBaseFeePerGas",
  "debug_traceTransaction",
  "debug_traceCall",
  "trace_call",
  "trace_transaction",
]);

// ─── 辅助函数 ───────────────────────────────────────────────────────
const isAddr = (s) => typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);

function ipLimit(ip) {
  const now = Date.now();
  const b = ipBucket.get(ip);
  if (!b || b.resetAt < now) {
    ipBucket.set(ip, { count: 1, resetAt: now + IP_LIMIT_WINDOW });
    return true;
  }
  if (b.count >= IP_LIMIT_MAX) return false;
  b.count++;
  return true;
}

async function anvilCall(method, params) {
  const res = await fetch(ANVIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

// ─── Express ────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(cors({ origin: true, credentials: false }));

// 信任反代（CF tunnel / nginx）给的真实 IP
app.set("trust proxy", true);

app.use((req, _res, next) => {
  if (!ipLimit(req.ip)) {
    return _res.status(429).json({ error: "ip rate limit" });
  }
  next();
});

// ─── /health ─────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  try {
    const r = await anvilCall("eth_blockNumber", []);
    res.json({ ok: true, blockNumber: r.result, time: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ ok: false, error: String(e) });
  }
});

// ─── /rpc ────────────────────────────────────────────────────────────
app.post("/rpc", async (req, res) => {
  const body = req.body;
  const items = Array.isArray(body) ? body : [body];

  // 校验每个 method
  for (const item of items) {
    if (!item || typeof item.method !== "string") {
      return res.status(400).json({ error: "invalid rpc body" });
    }
    if (BLOCKED_METHODS.has(item.method)) {
      return res.status(403).json({
        jsonrpc: "2.0", id: item.id, error: { code: -32601, message: "method blocked by proxy" }
      });
    }
    if (!ALLOWED_METHODS.has(item.method)) {
      return res.status(403).json({
        jsonrpc: "2.0", id: item.id, error: { code: -32601, message: `method not whitelisted: ${item.method}` }
      });
    }
  }

  // 直转给 Anvil
  try {
    const r = await fetch(ANVIL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: "anvil upstream error", detail: String(e) });
  }
});

// ─── /faucet?address=0x... ───────────────────────────────────────────
app.post("/faucet", async (req, res) => {
  const addr = (req.query.address || req.body?.address || "").toString().toLowerCase();
  if (!isAddr(addr)) return res.status(400).json({ ok: false, error: "bad address" });

  const now = Date.now();
  const last = lastFaucetAt.get(addr) || 0;
  if (now - last < FAUCET_COOLDOWN_MS) {
    const wait = Math.ceil((FAUCET_COOLDOWN_MS - (now - last)) / 1000);
    return res.status(429).json({ ok: false, error: "cooldown", waitSeconds: wait });
  }

  try {
    // 用 anvil_setBalance 直接给地址打钱 —— 不消耗任何账号
    const balanceHex = "0x" + BigInt(FAUCET_AMT).toString(16);
    const r = await anvilCall("anvil_setBalance", [addr, balanceHex]);
    if (r.error) return res.status(500).json({ ok: false, error: r.error });
    lastFaucetAt.set(addr, now);
    seenAddrs.add(addr);
    res.json({ ok: true, address: addr, amountWei: FAUCET_AMT });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ─── /stats ──────────────────────────────────────────────────────────
app.get("/stats", async (_req, res) => {
  try {
    const out = { ok: true, time: new Date().toISOString() };

    // chain info
    const [bn, gp] = await Promise.all([
      anvilCall("eth_blockNumber", []),
      anvilCall("eth_gasPrice", []),
    ]);
    out.blockNumber = parseInt(bn.result, 16);
    out.gasPrice    = parseInt(gp.result, 16);

    // 合约状态（只在配置了 CONTRACT 时读）
    if (CONTRACT && CONTRACT !== "") {
      // selectors via `cast sig <fn>`:
      const SEL = {
        totalSupply:   "0x18160ddd",
        totalMints:    "0x1f21bfbf",
        currentTarget: "0x39148c53",
        currentEra:    "0x973628f6",
        currentReward: "0x07621eca",
        mintsInWindow: "0x3d1ab70c",
      };
      const [ts, tm, ct, er, rw, mw] = await Promise.all([
        anvilCall("eth_call", [{ to: CONTRACT, data: SEL.totalSupply },   "latest"]),
        anvilCall("eth_call", [{ to: CONTRACT, data: SEL.totalMints },    "latest"]),
        anvilCall("eth_call", [{ to: CONTRACT, data: SEL.currentTarget }, "latest"]),
        anvilCall("eth_call", [{ to: CONTRACT, data: SEL.currentEra },    "latest"]),
        anvilCall("eth_call", [{ to: CONTRACT, data: SEL.currentReward }, "latest"]),
        anvilCall("eth_call", [{ to: CONTRACT, data: SEL.mintsInWindow }, "latest"]),
      ]);
      out.contract       = CONTRACT;
      out.totalSupply    = ts.result && ts.result !== "0x" ? BigInt(ts.result).toString() : null;
      out.totalMints     = tm.result && tm.result !== "0x" ? BigInt(tm.result).toString() : null;
      out.currentTarget  = ct.result && ct.result !== "0x" ? BigInt(ct.result).toString() : null;
      out.currentEra     = er.result && er.result !== "0x" ? BigInt(er.result).toString() : null;
      out.currentReward  = rw.result && rw.result !== "0x" ? BigInt(rw.result).toString() : null;
      out.mintsInWindow  = mw.result && mw.result !== "0x" ? BigInt(mw.result).toString() : null;
    }

    out.faucet = {
      addressesFunded: seenAddrs.size,
      cooldownMs: FAUCET_COOLDOWN_MS,
      amountPerCallWei: FAUCET_AMT,
    };

    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ─── /addrs ──────────────────────────────────────────────────────────
// 简单看板：哪些地址领过水龙头
app.get("/addrs", (_req, res) => {
  res.json({ count: seenAddrs.size, addresses: [...seenAddrs] });
});

// ─── Listen ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[obscura-proxy] listening on :${PORT}`);
  console.log(`[obscura-proxy] anvil upstream: ${ANVIL_URL}`);
  console.log(`[obscura-proxy] contract:       ${CONTRACT || "(not set)"}`);
  console.log(`[obscura-proxy] faucet amount:  ${FAUCET_AMT} wei`);
});
