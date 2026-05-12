# Obscura · 浏览器挖矿 ERC-20 教学复刻

> 用浏览器挖一个 ERC-20 代币，致敬 [hash256.org](https://hash256.org)。
> 单合约 PoW 矿币 · 公平挖矿 · 无管理员 · 后量子叙事 · **完整可跑通**

[![tests](https://github.com/joshua-yinshan/obscura-miner/actions/workflows/test.yml/badge.svg)](https://github.com/joshua-yinshan/obscura-miner/actions/workflows/test.yml)
![MIT License](https://img.shields.io/badge/license-MIT-green)
![Solidity 0.8.24](https://img.shields.io/badge/solidity-0.8.24-blue)
![Stress 98.1%](https://img.shields.io/badge/stress--test-98.1%25-brightgreen)

---

## 这是什么

一个**端到端可运行**的浏览器 PoW 挖矿项目：

- 🟢 **合约层（Solidity 0.8.24 + Foundry）**：单合约 ERC-20 + PoW 矿工，无 admin / 无 proxy / 无 selfdestruct
- 🟢 **前端（Next.js 14 + wagmi v2 + viem）**：终端美学 UI，连钱包即开挖
- 🟢 **矿工（Web Worker + @noble/hashes）**：多核并行 keccak256，单核 ~100k h/s
- 🟢 **代理 + 水龙头（Express）**：白名单 RPC 反代 + 自动给新钱包打测试 ETH
- 🟢 **压力测试**：20 并发矿工 / 90s / 962 mints / 98.1% 成功率

教学性质，**仅在测试网部署**。不发主网代币。

---

## 在线试玩（临时）

如果在「Obscura 公开测试期」内：

👉 **https://decide-sizes-starsmerchant-sat.trycloudflare.com**

> ⚠️ 公开测试结束后该 URL 可能下线。看本 repo 顶部 [Issues](../../issues) 是否有 "Demo Online" 标签判断。

---

## 30 秒快速理解

```
你的浏览器                  你的钱包                    合约
─────────                  ─────────                  ─────────
读 challenge ──────────►  
  (链上随你地址变)
  
开 N 个 Web Worker
枚举 nonce 直到
  keccak256(challenge||nonce) < target
                          
找到!  ───────────────────►
                          签名 mint(nonce) ──────────►
                                                     验证 PoW
                                                     _mint(你, 100 OBS)
                                                     halving / difficulty 调整
←──────────────────────── 余额 +100 OBS ◄────────────
```

**核心思路**：把比特币的「PoW 公平挖矿」装进一个以太坊智能合约 + 一个浏览器标签页。

---

## 目录结构

```
repo/
├── contracts/                  # Foundry 合约工程
│   ├── src/MineableToken.sol   # 核心合约（150 行）
│   ├── test/MineableToken.t.sol # 12 个测试用例
│   └── script/Deploy.s.sol
├── app/                        # Next.js 前端
│   ├── app/page.tsx            # 挖矿主页
│   ├── app/OnboardingCard.tsx  # 3 步引导（连钱包 / 加网络 / 领测试 ETH）
│   ├── app/ConnectButton.tsx   # 钱包选择下拉
│   ├── workers/miner.ts        # Web Worker 矿工
│   └── lib/{wagmi,contract}.ts
├── proxy/                      # Express 反代 + 水龙头
│   └── server.mjs              # /rpc /faucet /stats /health
└── scripts/                    # 工具脚本
    └── stress-test.mjs         # 并发挖矿压测
```

---

## 前置依赖

| 工具 | 用途 | 安装 |
|---|---|---|
| **Foundry** | Solidity 编译/测试/部署 | https://book.getfoundry.sh |
| **Node.js ≥ 18** | 前端 + 代理 | https://nodejs.org |
| **pnpm**（推荐）| 前端包管理 | `npm i -g pnpm` |
| **MetaMask** | 测试网钱包 | https://metamask.io |

---

## 本地完整跑通（约 10 分钟）

### 1. 装合约依赖 + 跑测试

```bash
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts --no-git
forge build
forge test -vv      # 应该看到 12 passed
```

### 2. 起本地链 + 部署合约

```bash
# 终端 A：本地链
anvil --port 8545 --host 127.0.0.1 --block-time 2

# 终端 B：部署
cd contracts
export PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export INITIAL_TARGET=244
forge script script/Deploy.s.sol:Deploy \
    --rpc-url http://localhost:8545 --broadcast --skip-simulation
# 记下打印的合约地址
```

### 3. 起代理 + 水龙头

```bash
cd proxy
npm install
CONTRACT_ADDRESS=<刚才的合约地址> node server.mjs
```

### 4. 起前端

```bash
cd app
pnpm install
# 编辑 .env.local（参考 .env.example）：
#   NEXT_PUBLIC_CONTRACT_ADDRESS=<合约地址>
#   NEXT_PUBLIC_CHAIN_ID=31337
#   NEXT_PUBLIC_RPC_URL=http://localhost:3001/rpc
#   NEXT_PUBLIC_FAUCET_URL=http://localhost:3001/faucet
pnpm dev
```

打开 http://localhost:3000，按引导卡 3 步走：连钱包 → 加网络 → 自动领测试 ETH → 开挖。

### 5.（可选）跑压力测试

```bash
cd scripts
npm install
PROXY=http://localhost:3001 CONTRACT=<合约地址> MINERS=20 DURATION_S=120 node stress-test.mjs
```

---

## 核心机制（一段话讲清楚）

**Challenge**：`keccak256(chainId ‖ contract ‖ miner ‖ epoch)` —— 每个矿工地址有自己的题目，**别人偷你的 nonce 也用不了**（防 mempool 抢矿）。

**Mint 条件**：`keccak256(challenge ‖ nonce) < currentTarget` —— 全网枚举，谁先猜到谁拿 100 OBS。

**4 个防作弊**：
1. Challenge 绑地址 → 防抢矿
2. Epoch 每 100 块（~20 min）轮换 → 预算 nonce 自动过期
3. (miner, nonce, epoch) 三元组只能用一次 → 防 replay
4. 每块限 10 mints → 防 burst / MEV

**Halving**：每 100,000 mints 奖励折半（100 → 50 → 25 ...），21M 封顶，全分发约 290 天。

**难度调整**：每 2,016 mints 一次，公式 `new_target = old_target × (actual_time / expected_time)`，±4× clamp，**全网收敛到 1 mint/min**。

---

## 安全设计

合约层：
- ❌ 无 `admin` / `owner` / `transferOwnership`
- ❌ 无 `proxy` / `upgradeTo`
- ❌ 无 `pause` / `unpause`
- ❌ 无 `selfdestruct` / `kill`
- ✅ `Math.mulDiv` 防难度公式溢出
- ✅ 12/12 测试覆盖所有边界

代理层：
- ✅ `/rpc` 方法白名单（只允许 `eth_*` `net_*` `web3_*`）
- ❌ `anvil_*` `hardhat_*` `debug_*` 等 admin 方法**直接 403**
- ✅ `/faucet` 同地址 1h cooldown
- ✅ 同 IP 1200 req/min 速率限制

---

## 测试覆盖

```
[PASS] test_InitialState
[PASS] test_MintWithValidNonce
[PASS] test_RejectInvalidNonce
[PASS] test_RejectWrongMiner        ← 别人提交你的 nonce 应失败
[PASS] test_RejectReplay            ← 同 nonce 再用应失败
[PASS] test_BlockCapEnforced        ← 同块第 11 次应失败
[PASS] test_EpochRotationInvalidatesPrecomputedNonce
[PASS] test_HalvingApplied          ← era 切换后奖励折半
[PASS] test_DifficultyAdjustsTighter_WhenMintingFast
[PASS] test_DifficultyAdjustsLooser_WhenMintingSlow
[PASS] test_SupplyCapEnforced
[PASS] test_DigestOfMatchesMintPath
```

---

## 性能档位

| 矿工实现 | 单核 hashrate | 备注 |
|---|---|---|
| **JS + @noble/hashes（本仓库）** | 50–200 kh/s | 零依赖 native，启动快 |
| Rust + WASM（计划中） | 1–3 Mh/s | ~15-30× 加速 |
| WebGPU（计划中） | 100–500 Mh/s | ~1000× 加速 |

---

## Roadmap

| Phase | 内容 | 状态 |
|---|---|---|
| **Phase 1** | 核心 PoW 挖矿（本仓库） | ✅ 完成 |
| Phase 2 | Genesis sale + 自动 seedPool（fair launch） | 📋 |
| Phase 3 | Uniswap V4 Hook 集成 + CREATE2 地址挖矿 | 📋 |
| Phase 4 | Rust + WASM 矿工 → WebGPU 矿工 | 📋 |
| Phase 5 | 矿池版本（去信任化 share 分润） | 📋 |
| Phase 6 | ZK + PoW（隐私挖矿） | 📋 |

---

## 合规与免责

- 本项目**仅用于教学**，演示 PoW + EVM 设计原理
- **不在主网部署**，不发行真实代币
- 不是投资建议，不是金融产品
- 命名 `Obscura` / `OBS` 是教学用名字，与原 HASH 代币无关

---

## 致谢

- 灵感与机制：[hash256.org](https://hash256.org) （[@hash256dotorg](https://x.com/hash256dotorg)）
- ERC-20：[OpenZeppelin](https://github.com/OpenZeppelin/openzeppelin-contracts)
- keccak256：[@noble/hashes](https://github.com/paulmillr/noble-hashes)
- 钱包接入：[wagmi](https://wagmi.sh) + [viem](https://viem.sh)
- 智能合约工具链：[Foundry](https://book.getfoundry.sh)

---

## 关注作者

本项目是 **隐山观察** 账号的「项目复刻」系列首发：
- 𝕏：[@yinshanguancha](https://x.com/yinshanguancha)
- 我们用大白话拆 crypto 项目，欢迎来玩

---

## License

[MIT](./LICENSE)
