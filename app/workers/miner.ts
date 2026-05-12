/// <reference lib="webworker" />
//
// Web Worker: keccak256 PoW 矿工
//
// 接收主线程发来的 (challenge, target, workerId, workerCount)，
// 在 nonce 空间内按 [workerId, workerId+workerCount, ...] 步长搜索，
// 找到第一个 keccak256(challenge || nonce) < target 的 nonce 就回报。
//
// 每搜索 `reportInterval` 次回报一次哈希率统计，避免轮询过密。
//
// 使用 @noble/hashes 的 keccak_256（纯 JS，~50–200 kh/s 取决于设备）。
// 进阶 Phase 4 可替换为 Rust+WASM（~2 Mh/s）或 WebGPU（~200 Mh/s）。

import { keccak_256 } from "@noble/hashes/sha3";

type StartMsg = {
  type: "start";
  challenge: `0x${string}`;
  target: string; // bigint as decimal string
  workerId: number;
  workerCount: number;
  reportInterval?: number;
};

type StopMsg = { type: "stop" };
type Msg = StartMsg | StopMsg;

let running = false;

self.onmessage = (ev: MessageEvent<Msg>) => {
  const msg = ev.data;
  if (msg.type === "stop") {
    running = false;
    return;
  }
  if (msg.type === "start") {
    run(msg);
  }
};

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length !== 64) throw new Error("challenge must be 32 bytes hex");
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    b[i] = parseInt(h.substr(i * 2, 2), 16);
  }
  return b;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

function writeUint256BE(buf: Uint8Array, offset: number, value: bigint) {
  let v = value;
  for (let i = 31; i >= 0; i--) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function bytesToBigIntBE(b: Uint8Array): bigint {
  let r = 0n;
  for (let i = 0; i < b.length; i++) r = (r << 8n) | BigInt(b[i]);
  return r;
}

function run(msg: StartMsg) {
  running = true;
  const challenge = hexToBytes(msg.challenge);
  const target = BigInt(msg.target);
  const reportEvery = Math.max(1000, msg.reportInterval ?? 5000);

  // 64-byte buffer: [challenge(32) | nonce(32)]
  const buf = new Uint8Array(64);
  buf.set(challenge, 0);

  let nonce = BigInt(msg.workerId);
  const step = BigInt(msg.workerCount);
  let attempts = 0;
  let lastTick = performance.now();

  while (running) {
    writeUint256BE(buf, 32, nonce);
    const hash = keccak_256(buf);
    const hashBig = bytesToBigIntBE(hash);
    if (hashBig < target) {
      self.postMessage({
        type: "found",
        workerId: msg.workerId,
        nonce: nonce.toString(),
        digest: "0x" + bytesToHex(hash),
        attempts,
      });
      running = false;
      return;
    }
    nonce += step;
    attempts++;

    if (attempts % reportEvery === 0) {
      const now = performance.now();
      const elapsed = now - lastTick;
      self.postMessage({
        type: "stat",
        workerId: msg.workerId,
        attempts: reportEvery,
        elapsedMs: elapsed,
      });
      lastTick = now;
    }
  }

  self.postMessage({ type: "stopped", workerId: msg.workerId });
}

export {};
