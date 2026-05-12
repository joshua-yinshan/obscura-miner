// 离线找 nonce：传入 challenge + targetShift，暴力枚举 keccak256(challenge || nonce) < 2^shift
// 用法: node find-nonce.mjs <challengeHex> <targetShift>
import { keccak_256 } from "../../app/node_modules/@noble/hashes/sha3.js";

const [, , challengeHex, shiftStr] = process.argv;
if (!challengeHex || !shiftStr) {
  console.error("Usage: node find-nonce.mjs <challengeHex> <targetShift>");
  process.exit(1);
}

const shift = BigInt(shiftStr);
const target = 1n << shift;

function hexToBytes(h) {
  h = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

function writeUint256BE(buf, off, v) {
  for (let i = 31; i >= 0; i--) {
    buf[off + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function bytesToBig(b) {
  let r = 0n;
  for (let i = 0; i < b.length; i++) r = (r << 8n) | BigInt(b[i]);
  return r;
}

const challenge = hexToBytes(challengeHex);
const buf = new Uint8Array(64);
buf.set(challenge, 0);

const t0 = Date.now();
let nonce = 0n;
while (true) {
  writeUint256BE(buf, 32, nonce);
  const h = keccak_256(buf);
  if (bytesToBig(h) < target) {
    const elapsed = Date.now() - t0;
    console.error(`found nonce=${nonce} in ${nonce + 1n} tries, ${elapsed}ms`);
    process.stdout.write(nonce.toString());
    process.exit(0);
  }
  nonce++;
  if (nonce > 10_000_000n) {
    console.error("exceeded 10M tries");
    process.exit(1);
  }
}
