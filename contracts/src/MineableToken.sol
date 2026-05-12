// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Obscura Mineable Token (OBS)
 *
 * 灵感来自 hash256.org 的 HASH 代币 —— 一个浏览器 PoW 挖矿的 ERC-20。
 * 本合约是该机制的复刻教学版（Phase 1 MVP）。
 *
 * 设计要点：
 *   - 单合约不可变。无 admin、无 proxy、无 selfdestruct
 *   - 所有 21M 代币只能通过 PoW 挖出（Phase 2 将加入 Genesis sale + V4 hook）
 *   - 矿工提交 nonce 满足 keccak256(challenge || nonce) < target 即可 mint
 *   - challenge 绑定矿工地址 → 防 mempool 抢矿
 *   - 同块限 10 mints → 防 burst
 *   - 每 100,000 mints 奖励折半（era）
 *   - 每 2016 mints 调整难度，目标 1 mint/min，±4× clamp
 */
contract MineableToken is ERC20 {
    // ─────────────────────────────  常量  ─────────────────────────────

    uint256 public constant MAX_SUPPLY = 21_000_000 * 1e18;
    uint256 public constant BASE_REWARD = 100 * 1e18;
    uint256 public constant HALVING_INTERVAL = 100_000;            // 每 N 次 mint 奖励折半
    uint256 public constant ADJUST_INTERVAL = 2_016;               // 每 N 次 mint 调一次难度
    uint256 public constant TARGET_INTERVAL = 60;                  // 目标出块: 60s
    uint256 public constant EPOCH_DURATION = 1_200;                // 20 分钟一个 epoch
    uint256 public constant MAX_MINTS_PER_BLOCK = 10;              // 同块上限
    uint256 public constant MAX_ERA = 64;                          // 64 次折半后奖励=0

    // ─────────────────────────────  状态  ─────────────────────────────

    uint256 public immutable launchTime;
    uint256 public currentTarget;                                  // 当前难度阈值（越小越难）
    uint256 public totalMints;                                     // 累计 mint 次数
    uint256 public mintsInWindow;                                  // 当前难度窗口内 mints
    uint256 public windowStartTime;                                // 当前难度窗口起始时间

    mapping(uint256 => uint256) public mintsAtBlock;               // 块号 => 该块 mint 数
    mapping(bytes32 => bool) public usedDigest;                    // 防 replay

    // ─────────────────────────────  事件  ─────────────────────────────

    event Mined(
        address indexed miner,
        uint256 indexed epoch,
        uint256 nonce,
        uint256 reward,
        bytes32 digest
    );

    event DifficultyAdjusted(
        uint256 oldTarget,
        uint256 newTarget,
        uint256 actualElapsed,
        uint256 expectedElapsed
    );

    // ─────────────────────────────  构造  ─────────────────────────────

    /**
     * @param initialTarget 初始难度阈值。测试网建议 2**240（1/65536 概率），主网建议更高。
     */
    constructor(uint256 initialTarget) ERC20("Obscura", "OBS") {
        require(initialTarget > 0, "target must be > 0");
        currentTarget = initialTarget;
        launchTime = block.timestamp;
        windowStartTime = block.timestamp;
    }

    // ─────────────────────────────  Views  ────────────────────────────

    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - launchTime) / EPOCH_DURATION;
    }

    function currentEra() public view returns (uint256) {
        return totalMints / HALVING_INTERVAL;
    }

    function currentReward() public view returns (uint256) {
        uint256 era = currentEra();
        if (era >= MAX_ERA) return 0;
        return BASE_REWARD >> era;
    }

    function challengeOf(address miner) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(block.chainid, address(this), miner, currentEpoch())
        );
    }

    /**
     * @notice 给定 (miner, nonce, epoch) 计算 digest，前端 / 链下模拟用。
     */
    function digestOf(address miner, uint256 nonce, uint256 epoch)
        external
        view
        returns (bytes32)
    {
        bytes32 challenge =
            keccak256(abi.encodePacked(block.chainid, address(this), miner, epoch));
        return keccak256(abi.encodePacked(challenge, nonce));
    }

    function mintsRemaining() external view returns (uint256) {
        uint256 supply = totalSupply();
        return supply >= MAX_SUPPLY ? 0 : MAX_SUPPLY - supply;
    }

    // ─────────────────────────────  Mining  ───────────────────────────

    /**
     * @notice 提交一个 PoW nonce 来 mint 当前 era 的奖励。
     */
    function mint(uint256 nonce) external {
        require(totalSupply() < MAX_SUPPLY, "supply capped");
        require(mintsAtBlock[block.number] < MAX_MINTS_PER_BLOCK, "block cap reached");

        bytes32 challenge = challengeOf(msg.sender);
        bytes32 digest = keccak256(abi.encodePacked(challenge, nonce));
        require(uint256(digest) < currentTarget, "invalid PoW");
        require(!usedDigest[digest], "digest already used");
        usedDigest[digest] = true;

        uint256 reward = currentReward();
        require(reward > 0, "mining ended");

        // 不超过 cap
        uint256 remaining = MAX_SUPPLY - totalSupply();
        if (reward > remaining) reward = remaining;

        mintsAtBlock[block.number]++;
        totalMints++;
        mintsInWindow++;

        _mint(msg.sender, reward);

        emit Mined(msg.sender, currentEpoch(), nonce, reward, digest);

        if (mintsInWindow >= ADJUST_INTERVAL) {
            _adjustDifficulty();
        }
    }

    // ─────────────────────────────  Internal  ─────────────────────────

    function _adjustDifficulty() internal {
        uint256 actual = block.timestamp - windowStartTime;
        uint256 expected = ADJUST_INTERVAL * TARGET_INTERVAL;

        // clamp 到 [expected/4, expected*4]
        uint256 minE = expected / 4;
        uint256 maxE = expected * 4;
        uint256 clampedActual = actual < minE ? minE : (actual > maxE ? maxE : actual);

        uint256 oldTarget = currentTarget;
        // 用 Math.mulDiv 走 512-bit 中间运算，避免 oldTarget * clampedActual 在大 target 时溢出
        uint256 newTarget = Math.mulDiv(oldTarget, clampedActual, expected);
        if (newTarget == 0) newTarget = 1;

        currentTarget = newTarget;
        mintsInWindow = 0;
        windowStartTime = block.timestamp;

        emit DifficultyAdjusted(oldTarget, newTarget, actual, expected);
    }
}
