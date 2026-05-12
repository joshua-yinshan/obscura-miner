"use client";

import { useEffect, useState, useCallback } from "react";
import { useAccount, useBalance, useSwitchChain, useChainId } from "wagmi";
import { formatEther } from "viem";

const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337);
const CHAIN_NAME = process.env.NEXT_PUBLIC_CHAIN_NAME ?? "Obscura Testnet";
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://localhost:3001/rpc";
const FAUCET_URL = process.env.NEXT_PUBLIC_FAUCET_URL ?? "http://localhost:3001/faucet";

const MIN_BALANCE_WEI = 100_000_000_000_000n; // 0.0001 ETH，低于这个就当作"没钱"

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
function getInjected(): Eip1193 | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { ethereum?: Eip1193 };
  return w.ethereum;
}

export function OnboardingCard() {
  const { address, isConnected, chain } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  const { data: bal, refetch: refetchBalance } = useBalance({
    address,
    query: { enabled: !!address, refetchInterval: 5000 },
  });

  const [faucetState, setFaucetState] = useState<"idle" | "calling" | "ok" | "cooldown" | "fail">("idle");
  const [faucetMsg, setFaucetMsg] = useState<string>("");
  const [autoTriggered, setAutoTriggered] = useState(false);

  const onCorrectChain = chainId === CHAIN_ID;
  const hasBalance = bal && bal.value >= MIN_BALANCE_WEI;
  const ready = isConnected && onCorrectChain && hasBalance;

  // ─── 加网络 (EIP-3085) ─────────────────────────────────────────────
  const addNetwork = useCallback(async () => {
    const eth = getInjected();
    if (!eth) {
      alert("没检测到钱包扩展。请先装 MetaMask 等浏览器钱包。");
      return;
    }
    try {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0x" + CHAIN_ID.toString(16),
            chainName: CHAIN_NAME,
            nativeCurrency: { name: "Test ETH", symbol: "tETH", decimals: 18 },
            rpcUrls: [RPC_URL],
            blockExplorerUrls: [],
          },
        ],
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("addNetwork failed:", msg);
    }
  }, []);

  // ─── 调水龙头 ───────────────────────────────────────────────────────
  const callFaucet = useCallback(async () => {
    if (!address) return;
    setFaucetState("calling");
    setFaucetMsg("打水中…");
    try {
      const r = await fetch(`${FAUCET_URL}?address=${address}`, { method: "POST" });
      const j = await r.json();
      if (r.ok && j.ok) {
        setFaucetState("ok");
        setFaucetMsg("✓ 1 ETH 已到账");
        setTimeout(() => refetchBalance(), 500);
      } else if (r.status === 429 && j.error === "cooldown") {
        setFaucetState("cooldown");
        setFaucetMsg(`冷却中，${j.waitSeconds}s 后可再领`);
      } else {
        setFaucetState("fail");
        setFaucetMsg(`失败：${j.error ?? "未知错误"}`);
      }
    } catch (e) {
      setFaucetState("fail");
      setFaucetMsg(`网络错误：${e instanceof Error ? e.message : "fetch failed"}`);
    }
  }, [address, refetchBalance]);

  // ─── 第一次连上 + 钱包是空的 → 自动调一次水龙头 ───────────────────
  useEffect(() => {
    if (!autoTriggered && isConnected && onCorrectChain && bal && bal.value < MIN_BALANCE_WEI) {
      setAutoTriggered(true);
      callFaucet();
    }
  }, [autoTriggered, isConnected, onCorrectChain, bal, callFaucet]);

  // 全部就绪后，3 秒后隐藏卡片
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (ready && !dismissed) {
      const t = setTimeout(() => setDismissed(true), 5000);
      return () => clearTimeout(t);
    }
  }, [ready, dismissed]);

  if (dismissed && ready) return null;

  // ─── UI ───────────────────────────────────────────────────────────
  return (
    <section className="card">
      <span className="card-title">测试引导</span>
      <p className="mt-2 text-xs text-terminal-bright">
        这是 <span className="text-terminal-fg">Obscura</span> 测试网。免费玩、不消耗真钱。
        按 3 步走，钱包会自动配好。
      </p>

      <div className="mt-4 space-y-2 text-xs">
        {/* Step 1: connect */}
        <Step
          done={isConnected}
          label="1. 连接浏览器钱包"
          hint={isConnected ? `${address?.slice(0, 6)}…${address?.slice(-4)}` : "右上点 CONNECT INJECTED"}
        />

        {/* Step 2: switch chain */}
        <Step
          done={isConnected && onCorrectChain}
          label={`2. 切换到 ${CHAIN_NAME}`}
          hint={
            !isConnected
              ? "先完成步骤 1"
              : onCorrectChain
                ? `已在 ${CHAIN_NAME} (chainId ${CHAIN_ID})`
                : `当前在 ${chain?.name ?? "未知网络"}`
          }
          action={
            isConnected && !onCorrectChain ? (
              <div className="flex gap-2">
                <button
                  className="btn-ghost btn"
                  onClick={() => switchChain({ chainId: CHAIN_ID as 31337 })}
                >
                  ▸ 切换网络
                </button>
                <button className="btn-ghost btn" onClick={addNetwork}>
                  ▸ 加网络（首次）
                </button>
              </div>
            ) : null
          }
        />

        {/* Step 3: get test ETH */}
        <Step
          done={!!hasBalance}
          label="3. 拿到测试 ETH"
          hint={
            !isConnected
              ? "先完成步骤 1"
              : !onCorrectChain
                ? "先完成步骤 2"
                : bal
                  ? `余额 ${Number(formatEther(bal.value)).toFixed(4)} ${bal.symbol}`
                  : "查询中…"
          }
          action={
            isConnected && onCorrectChain && !hasBalance ? (
              <div className="flex items-center gap-3">
                <button
                  className="btn"
                  disabled={faucetState === "calling"}
                  onClick={callFaucet}
                >
                  ▸ {faucetState === "calling" ? "打水中…" : "领取 1 测试 ETH"}
                </button>
                {faucetMsg && (
                  <span
                    className={
                      faucetState === "ok"
                        ? "text-terminal-fg"
                        : faucetState === "cooldown"
                          ? "text-terminal-amber"
                          : faucetState === "fail"
                            ? "text-terminal-red"
                            : "text-terminal-bright"
                    }
                  >
                    {faucetMsg}
                  </span>
                )}
              </div>
            ) : null
          }
        />
      </div>

      {ready && (
        <p className="mt-4 text-xs text-terminal-fg">
          ✓ 全部就绪。下面的「开始挖矿」按钮可以点了。这条提示 5 秒后自动消失。
        </p>
      )}
    </section>
  );
}

function Step({
  done,
  label,
  hint,
  action,
}: {
  done: boolean;
  label: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3 flex-wrap">
      <span className={done ? "text-terminal-fg" : "text-terminal-mid"}>
        [{done ? "✓" : "○"}]
      </span>
      <span className={done ? "text-terminal-fg" : "text-terminal-bright"}>
        {label}
      </span>
      {hint && <span className="text-terminal-mid">— {hint}</span>}
      {action && <span className="ml-auto">{action}</span>}
    </div>
  );
}
