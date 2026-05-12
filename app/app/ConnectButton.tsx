"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";

/**
 * 折叠式钱包连接按钮。
 *  - 未连接 + 1 个 connector → 直接显示一个 "Connect Wallet" 按钮
 *  - 未连接 + 多个 connector → 按钮带 ▾，点击展开下拉让用户选
 *  - 已连接 → 显示地址简写 + disconnect
 */
export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // 点外面关掉下拉
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (isConnected) {
    return (
      <button className="btn-ghost btn" onClick={() => disconnect()}>
        {address?.slice(0, 6)}…{address?.slice(-4)} · disconnect
      </button>
    );
  }

  // 只有 1 个 connector → 直接连
  if (connectors.length <= 1) {
    return (
      <button
        className="btn"
        disabled={isPending || connectors.length === 0}
        onClick={() => connectors[0] && connect({ connector: connectors[0] })}
      >
        {isPending ? "Connecting…" : connectors.length === 0 ? "No wallet found" : "Connect Wallet"}
      </button>
    );
  }

  // 多个 connector → 下拉选
  return (
    <div className="relative" ref={ref}>
      <button className="btn" onClick={() => setOpen((o) => !o)}>
        Connect Wallet ▾
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-50 min-w-[220px] border border-terminal-mid"
          style={{ background: "#000" }}
        >
          <div className="py-1 text-xs text-terminal-mid uppercase tracking-wider px-3 pt-2 pb-1">
            choose wallet
          </div>
          {connectors.map((c) => (
            <button
              key={c.uid}
              className="block w-full text-left px-3 py-2 text-terminal-fg hover:bg-terminal-dim transition-colors text-xs"
              onClick={() => {
                connect({ connector: c });
                setOpen(false);
              }}
            >
              ▸ {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
