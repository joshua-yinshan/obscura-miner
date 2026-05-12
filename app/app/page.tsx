"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useAccount,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { formatEther } from "viem";
import { ABI, CONTRACT_ADDRESS } from "@/lib/contract";
import { activeChain } from "@/lib/wagmi";
import { OnboardingCard } from "./OnboardingCard";
import { ConnectButton } from "./ConnectButton";

const SOLUTIONS_LS_KEY = "obscura.solutions.v1";

type WorkerStat = { hashrate: number; attempts: number };
type Solution = {
  nonce: string;
  digest: string;
  epoch: string;
  reward?: bigint;
  txHash?: `0x${string}`;
  status: "found" | "submitting" | "confirmed" | "failed";
};

const CONTRACT = CONTRACT_ADDRESS;

function formatBig(n: bigint, decimals = 18, dp = 4): string {
  const s = formatEther(n);
  const [i, f = ""] = s.split(".");
  return dp > 0 ? `${i}.${f.padEnd(dp, "0").slice(0, dp)}` : i;
}

function formatHashrate(hps: number): string {
  if (hps >= 1e9) return `${(hps / 1e9).toFixed(2)} Gh/s`;
  if (hps >= 1e6) return `${(hps / 1e6).toFixed(2)} Mh/s`;
  if (hps >= 1e3) return `${(hps / 1e3).toFixed(2)} kh/s`;
  return `${hps.toFixed(0)} h/s`;
}

function Bar({ filled, color = "green" }: { filled: number; color?: "green" | "amber" }) {
  const pct = Math.min(100, Math.max(0, filled * 100));
  const fillColor = color === "amber" ? "#FFB000" : "#00FF66";
  return (
    <div className="flex items-center gap-2 w-full">
      <span className="text-terminal-mid">[</span>
      <div className="flex-1 min-w-0 h-3 relative overflow-hidden" style={{ background: "#001a08" }}>
        <div className="h-full transition-[width] duration-300" style={{ width: `${pct}%`, background: fillColor }} />
      </div>
      <span className="text-terminal-mid">]</span>
      <span
        className="tabular-nums text-right shrink-0"
        style={{ color: fillColor, minWidth: "4.5rem" }}
      >
        {pct.toFixed(2)}%
      </span>
    </div>
  );
}

export default function Home() {
  const { address, isConnected, chain } = useAccount();

  // ────────── 链上状态读取（multicall，5s 轮询）──────────
  const reads = useReadContracts({
    contracts: address
      ? [
          { address: CONTRACT, abi: ABI, functionName: "challengeOf", args: [address] },
          { address: CONTRACT, abi: ABI, functionName: "currentTarget" },
          { address: CONTRACT, abi: ABI, functionName: "currentEpoch" },
          { address: CONTRACT, abi: ABI, functionName: "currentEra" },
          { address: CONTRACT, abi: ABI, functionName: "currentReward" },
          { address: CONTRACT, abi: ABI, functionName: "totalMints" },
          { address: CONTRACT, abi: ABI, functionName: "totalSupply" },
          { address: CONTRACT, abi: ABI, functionName: "MAX_SUPPLY" },
          { address: CONTRACT, abi: ABI, functionName: "balanceOf", args: [address] },
          { address: CONTRACT, abi: ABI, functionName: "mintsInWindow" },
          { address: CONTRACT, abi: ABI, functionName: "ADJUST_INTERVAL" },
          { address: CONTRACT, abi: ABI, functionName: "HALVING_INTERVAL" },
        ]
      : [],
    query: { refetchInterval: 5000, enabled: !!address && CONTRACT !== "0x0000000000000000000000000000000000000000" },
  });

  const data = reads.data;
  const challenge = data?.[0]?.result as `0x${string}` | undefined;
  const target = data?.[1]?.result as bigint | undefined;
  const currentEpoch = data?.[2]?.result as bigint | undefined;
  const currentEra = data?.[3]?.result as bigint | undefined;
  const reward = data?.[4]?.result as bigint | undefined;
  const totalMints = data?.[5]?.result as bigint | undefined;
  const totalSupply = data?.[6]?.result as bigint | undefined;
  const maxSupply = data?.[7]?.result as bigint | undefined;
  const balance = data?.[8]?.result as bigint | undefined;
  const mintsInWindow = data?.[9]?.result as bigint | undefined;
  const adjustInterval = data?.[10]?.result as bigint | undefined;
  const halvingInterval = data?.[11]?.result as bigint | undefined;

  // ────────── Worker 池 ──────────
  const workersRef = useRef<Worker[]>([]);
  const [coreCount, setCoreCount] = useState(0);
  const [isMining, setMining] = useState(false);
  const [workerStats, setWorkerStats] = useState<Record<number, WorkerStat>>({});
  const [solutions, setSolutions] = useState<Solution[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem(SOLUTIONS_LS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.slice(0, 50) : [];
    } catch {
      return [];
    }
  });
  const [pendingNonce, setPendingNonce] = useState<string | null>(null);
  const [logMsg, setLogMsg] = useState<string>("idle");

  // 持久化 solutions（drop bigint reward 字段以保证 JSON 可序列化）
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const stripped = solutions.slice(0, 50).map(({ reward, ...rest }) => rest);
      localStorage.setItem(SOLUTIONS_LS_KEY, JSON.stringify(stripped));
    } catch {}
  }, [solutions]);

  useEffect(() => {
    if (typeof navigator !== "undefined") {
      setCoreCount(Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1));
    }
  }, []);

  const stopWorkers = useCallback(() => {
    workersRef.current.forEach((w) => {
      try {
        w.postMessage({ type: "stop" });
        w.terminate();
      } catch {}
    });
    workersRef.current = [];
  }, []);

  const startWorkers = useCallback(
    (ch: `0x${string}`, tgt: bigint, count: number) => {
      stopWorkers();
      setWorkerStats({});
      const workers: Worker[] = [];
      for (let i = 0; i < count; i++) {
        const w = new Worker(new URL("../workers/miner.ts", import.meta.url), {
          type: "module",
        });
        w.onmessage = (ev: MessageEvent<any>) => onWorkerMsg(ev);
        w.postMessage({
          type: "start",
          challenge: ch,
          target: tgt.toString(),
          workerId: i,
          workerCount: count,
          reportInterval: 5000,
        });
        workers.push(w);
      }
      workersRef.current = workers;
    },
    [stopWorkers],
  );

  const { writeContractAsync } = useWriteContract();
  const [lastTx, setLastTx] = useState<`0x${string}` | undefined>();
  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: lastTx });

  const submitNonce = useCallback(
    async (nonceStr: string, digest: string, epoch: string) => {
      if (pendingNonce) return;
      setPendingNonce(nonceStr);
      setSolutions((prev) => [
        { nonce: nonceStr, digest, epoch, status: "submitting" },
        ...prev,
      ]);
      try {
        const tx = await writeContractAsync({
          address: CONTRACT,
          abi: ABI,
          functionName: "mint",
          args: [BigInt(nonceStr)],
        });
        setLastTx(tx);
        setSolutions((prev) =>
          prev.map((s) =>
            s.nonce === nonceStr ? { ...s, txHash: tx, status: "submitting" } : s,
          ),
        );
        setLogMsg(`tx sent: ${tx.slice(0, 10)}…  waiting for confirmation`);
      } catch (e: any) {
        const msg = e?.shortMessage ?? e?.message ?? "unknown error";
        setLogMsg(`submit failed: ${msg}`);
        setSolutions((prev) =>
          prev.map((s) => (s.nonce === nonceStr ? { ...s, status: "failed" } : s)),
        );
        setPendingNonce(null);
      }
    },
    [pendingNonce, writeContractAsync],
  );

  // 接收 worker 消息
  const onWorkerMsg = useCallback(
    (ev: MessageEvent<any>) => {
      const m = ev.data;
      if (m.type === "stat") {
        const hr = (m.attempts * 1000) / Math.max(1, m.elapsedMs);
        setWorkerStats((prev) => ({
          ...prev,
          [m.workerId]: {
            hashrate: hr,
            attempts: (prev[m.workerId]?.attempts ?? 0) + m.attempts,
          },
        }));
      } else if (m.type === "found") {
        stopWorkers();
        setLogMsg(`found nonce by worker #${m.workerId}: ${m.nonce}`);
        submitNonce(m.nonce, m.digest, currentEpoch?.toString() ?? "?");
      }
    },
    [currentEpoch, stopWorkers, submitNonce],
  );

  // tx 确认后处理：刷新读取 + 重启 workers
  useEffect(() => {
    if (!isConfirmed || !lastTx) return;
    setSolutions((prev) =>
      prev.map((s) => (s.txHash === lastTx ? { ...s, status: "confirmed" } : s)),
    );
    setPendingNonce(null);
    setLogMsg(`confirmed: ${lastTx.slice(0, 10)}…  refreshing & restarting`);
    reads.refetch();
    // 用最新 challenge/target 重启 workers (要 setTimeout 让 reads.refetch 完成)
    setTimeout(() => {
      if (!isMining) return;
      if (challenge && target) startWorkers(challenge, target, coreCount);
    }, 600);
  }, [isConfirmed, lastTx]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = useCallback(() => {
    if (!challenge || !target) return;
    setMining(true);
    setLogMsg(`mining started with ${coreCount} workers`);
    startWorkers(challenge, target, coreCount);
  }, [challenge, target, coreCount, startWorkers]);

  const stop = useCallback(() => {
    setMining(false);
    stopWorkers();
    setLogMsg("mining stopped");
  }, [stopWorkers]);

  useEffect(() => () => stopWorkers(), [stopWorkers]);

  // ────────── 派生值 ──────────
  const totalHashrate = useMemo(
    () => Object.values(workerStats).reduce((sum, s) => sum + s.hashrate, 0),
    [workerStats],
  );
  const totalAttempts = useMemo(
    () => Object.values(workerStats).reduce((sum, s) => sum + s.attempts, 0),
    [workerStats],
  );

  const mineProgress =
    totalSupply !== undefined && maxSupply !== undefined && maxSupply > 0n
      ? Number((totalSupply * 10000n) / maxSupply) / 10000
      : 0;

  const adjustProgress =
    mintsInWindow !== undefined && adjustInterval !== undefined && adjustInterval > 0n
      ? Number((mintsInWindow * 10000n) / adjustInterval) / 10000
      : 0;

  const haveContract = CONTRACT !== "0x0000000000000000000000000000000000000000";
  const onCorrectChain = chain?.id === activeChain.id;

  return (
    <main className="min-h-screen max-w-5xl mx-auto px-6 py-8 space-y-8">
      {/* Header */}
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <span className="text-terminal-fg text-lg font-bold">$OBS</span>
          <span className="text-terminal-mid">//</span>
          <span className="text-terminal-bright">浏览器挖矿</span>
          <span className="text-terminal-mid">·</span>
          <span className="text-terminal-bright">后量子</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-terminal-mid text-xs">
            {activeChain.name} · {activeChain.id}
          </span>
          <ConnectButton />
        </div>
      </header>

      {/* 引导卡：连钱包 → 加网络 → 拿测试 ETH */}
      {!haveContract ? (
        <div className="card">
          <span className="card-title text-terminal-red">配置缺失</span>
          <div className="text-terminal-red text-xs">
            未配置 NEXT_PUBLIC_CONTRACT_ADDRESS。先部署合约（见 README），把地址填到 .env.local。
          </div>
        </div>
      ) : (
        <OnboardingCard />
      )}

      {/* Mining Status */}
      <section className="card">
        <span className="card-title">挖矿状态</span>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1 mt-2">
          <Row label="纪元 (Epoch)" value={currentEpoch?.toString() ?? "—"} />
          <Row label="时代 (Era)" value={currentEra?.toString() ?? "—"} />
          <Row
            label="当前奖励"
            value={reward !== undefined ? `${formatBig(reward, 18, 2)} OBS` : "—"}
          />
          <Row label="累计 mints" value={totalMints?.toString() ?? "—"} />
          <Row
            label="next retarget"
            value={
              mintsInWindow !== undefined && adjustInterval !== undefined
                ? `${mintsInWindow.toString()} / ${adjustInterval.toString()}`
                : "—"
            }
          />
          <Row
            label="当前 target"
            value={target ? `0x${target.toString(16).padStart(64, "0").slice(0, 16)}…` : "—"}
          />
          <Row
            label="totalSupply"
            value={totalSupply !== undefined ? `${formatBig(totalSupply, 18, 0)} OBS` : "—"}
          />
          <Row
            label="MAX_SUPPLY"
            value={maxSupply !== undefined ? `${formatBig(maxSupply, 18, 0)} OBS` : "—"}
          />
          <Row
            label="你的余额"
            value={balance !== undefined ? `${formatBig(balance, 18, 4)} OBS` : "—"}
          />
        </div>

        <div className="mt-5 space-y-2">
          <div className="text-xs text-terminal-bright uppercase tracking-wider">
            总挖矿进度
          </div>
          <Bar filled={mineProgress} color="green" />
          <div className="text-xs text-terminal-bright uppercase tracking-wider mt-3">
            本难度窗口进度
          </div>
          <Bar filled={adjustProgress} color="amber" />
        </div>
      </section>

      {/* Browser Miner */}
      <section className="card">
        <span className="card-title">浏览器矿工</span>
        <div className="flex items-center justify-between gap-4 flex-wrap mt-2">
          <div className="text-xs text-terminal-mid">
            {isMining
              ? `running · ${coreCount} workers`
              : !isConnected
                ? "idle · 先在上方连接钱包"
                : !onCorrectChain
                  ? "idle · 切到正确网络后再开始"
                  : !challenge
                    ? "idle · 等读取合约状态…"
                    : "idle · 准备就绪，点右侧开始挖矿"}
          </div>
          <div className="flex gap-2">
            {!isMining ? (
              <button
                className="btn"
                disabled={!isConnected || !haveContract || !onCorrectChain || !challenge}
                onClick={start}
              >
                ▸ 开始挖矿
              </button>
            ) : (
              <button className="btn btn-ghost" onClick={stop}>
                ■ 停止
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1 mt-4">
          <Row label="哈希速率" value={isMining ? formatHashrate(totalHashrate) : "—"} />
          <Row label="尝试次数" value={isMining || totalAttempts > 0 ? totalAttempts.toLocaleString() : "—"} />
          <Row
            label="活跃 workers"
            value={isMining ? coreCount.toString() : `— (待用 ${coreCount})`}
          />
          <Row
            label="提交中"
            value={pendingNonce ? `${pendingNonce.slice(0, 16)}… (${isConfirming ? "confirming" : "signing"})` : "—"}
          />
          <Row
            label="挑战"
            value={challenge ? `${challenge.slice(0, 18)}…${challenge.slice(-6)}` : "—"}
          />
          <Row label="状态" value={logMsg} />
        </div>
      </section>

      {/* Solutions */}
      <section className="card">
        <span className="card-title">SOLUTIONS</span>
        {solutions.length === 0 ? (
          <div className="text-terminal-mid mt-2 text-xs">
            尚无 solutions。开始挖矿后，找到的 nonce 会出现在这里。
          </div>
        ) : (
          <ul className="mt-2 space-y-1 text-xs">
            {solutions.slice(0, 20).map((s, i) => (
              <li key={i} className="flex items-center gap-3">
                <span className="text-terminal-mid">#{solutions.length - i}</span>
                <span
                  className={
                    s.status === "confirmed"
                      ? "text-terminal-fg"
                      : s.status === "failed"
                        ? "text-terminal-red"
                        : "text-terminal-amber"
                  }
                >
                  [{s.status}]
                </span>
                <span className="text-terminal-bright">nonce={s.nonce.slice(0, 18)}…</span>
                <span className="text-terminal-mid">epoch={s.epoch}</span>
                {s.txHash && (
                  <a
                    className="text-terminal-fg underline"
                    href={`${activeChain.blockExplorers?.default?.url}/tx/${s.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {s.txHash.slice(0, 10)}…
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* How it works */}
      <section className="card">
        <span className="card-title">原理</span>
        <ol className="mt-2 space-y-1.5 text-xs text-terminal-bright">
          <li>
            <span className="text-terminal-mid">01</span> 浏览器读取合约绑定到你地址的
            challenge: <code>keccak256(chainId ‖ contract ‖ you ‖ epoch)</code>。
          </li>
          <li>
            <span className="text-terminal-mid">02</span> N 个 Web Worker 并行枚举 nonce，
            搜索使 <code>keccak256(challenge ‖ nonce) &lt; target</code> 成立的解。
          </li>
          <li>
            <span className="text-terminal-mid">03</span> 命中后调用 <code>mint(nonce)</code>，
            合约验证 PoW、铸造奖励、按 era 自动减半。
          </li>
          <li>
            <span className="text-terminal-mid">04</span> 每 100 个 epoch 块（约 20 分钟）轮换
            challenge → 防 mempool 抢矿、防 nonce 预算复用。
          </li>
          <li>
            <span className="text-terminal-mid">05</span> 每 2016 mints 调整难度，
            ±4× clamp，全网收敛到 1 mint/min。
          </li>
        </ol>
        <p className="mt-4 text-xs text-terminal-mid leading-relaxed">
          灵感来自{" "}
          <a className="underline" href="https://hash256.org" target="_blank" rel="noreferrer">
            hash256.org
          </a>{" "}
          的 HASH 代币。本仓库为教学复刻，仅在测试网部署。 未来 Phase 将加入 Genesis sale +
          Uniswap V4 hook 集成。
        </p>
      </section>

      <footer className="text-xs text-terminal-mid pb-8">
        contract:{" "}
        <a
          className="underline"
          href={`${activeChain.blockExplorers?.default?.url}/address/${CONTRACT}`}
          target="_blank"
          rel="noreferrer"
        >
          {CONTRACT.slice(0, 6)}…{CONTRACT.slice(-4)}
        </a>
      </footer>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="dot-row">
      <span className="label">{label}</span>
      <span className="dots" />
      <span className="value">{value}</span>
    </div>
  );
}
