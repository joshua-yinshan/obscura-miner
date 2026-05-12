// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {MineableToken} from "../src/MineableToken.sol";

contract MineableTokenTest is Test {
    using stdStorage for StdStorage;

    MineableToken internal token;

    // 测试用初始难度：2^248 = 1 / 256 命中概率，约每 256 次 keccak 命中一次
    uint256 internal constant TEST_TARGET = 1 << 248;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        token = new MineableToken(TEST_TARGET);
    }

    // ─────────────────────────────  Helpers  ──────────────────────────

    /// @dev 暴力搜索一个对 miner 有效的 nonce（用当前 epoch 的 challenge）。
    function _findNonce(address miner, uint256 start) internal view returns (uint256) {
        bytes32 challenge = token.challengeOf(miner);
        uint256 target = token.currentTarget();
        for (uint256 n = start; n < start + 1_000_000; n++) {
            bytes32 d = keccak256(abi.encodePacked(challenge, n));
            if (uint256(d) < target) return n;
        }
        revert("no valid nonce found in 1M iterations");
    }

    /// @dev 找 count 个连续有效 nonce。
    function _findNonces(address miner, uint256 count) internal view returns (uint256[] memory) {
        bytes32 challenge = token.challengeOf(miner);
        uint256 target = token.currentTarget();
        uint256[] memory nonces = new uint256[](count);
        uint256 found = 0;
        for (uint256 n = 0; found < count && n < 10_000_000; n++) {
            bytes32 d = keccak256(abi.encodePacked(challenge, n));
            if (uint256(d) < target) {
                nonces[found++] = n;
            }
        }
        require(found == count, "not enough nonces");
        return nonces;
    }

    // ─────────────────────────────  Tests  ────────────────────────────

    function test_InitialState() public view {
        assertEq(token.name(), "Obscura");
        assertEq(token.symbol(), "OBS");
        assertEq(token.totalSupply(), 0);
        assertEq(token.MAX_SUPPLY(), 21_000_000 * 1e18);
        assertEq(token.currentTarget(), TEST_TARGET);
        assertEq(token.currentReward(), 100 * 1e18);
        assertEq(token.currentEra(), 0);
        assertEq(token.currentEpoch(), 0);
    }

    function test_MintWithValidNonce() public {
        uint256 nonce = _findNonce(alice, 0);

        vm.prank(alice);
        token.mint(nonce);

        assertEq(token.balanceOf(alice), 100 * 1e18);
        assertEq(token.totalMints(), 1);
        assertEq(token.mintsInWindow(), 1);
    }

    function test_RejectInvalidNonce() public {
        // 使用一个几乎肯定不满足难度的 nonce
        vm.prank(alice);
        vm.expectRevert(bytes("invalid PoW"));
        token.mint(type(uint256).max);
    }

    function test_RejectWrongMiner() public {
        // Alice 找的 nonce，Bob 提交 —— challenge 不一样会失败
        uint256 nonce = _findNonce(alice, 0);

        vm.prank(bob);
        vm.expectRevert(bytes("invalid PoW"));
        token.mint(nonce);
    }

    function test_RejectReplay() public {
        uint256 nonce = _findNonce(alice, 0);

        vm.prank(alice);
        token.mint(nonce);

        // 同一 nonce 再来一次必须 revert (usedDigest)
        vm.prank(alice);
        vm.expectRevert(bytes("digest already used"));
        token.mint(nonce);
    }

    function test_BlockCapEnforced() public {
        uint256[] memory nonces = _findNonces(alice, 11);

        // 在同一个 block 里 mint 11 次，第 11 次应失败
        for (uint256 i = 0; i < 10; i++) {
            vm.prank(alice);
            token.mint(nonces[i]);
        }

        vm.prank(alice);
        vm.expectRevert(bytes("block cap reached"));
        token.mint(nonces[10]);

        // 下一个块就可以
        vm.roll(block.number + 1);
        vm.prank(alice);
        token.mint(nonces[10]);

        assertEq(token.balanceOf(alice), 11 * 100 * 1e18);
    }

    function test_EpochRotationInvalidatesPrecomputedNonce() public {
        uint256 nonce = _findNonce(alice, 0);
        assertEq(token.currentEpoch(), 0);

        // 跳过一个 epoch（20 min + 1 秒）
        vm.warp(block.timestamp + 1201);
        assertEq(token.currentEpoch(), 1);

        // 旧 epoch 算出的 nonce 在新 epoch 下大概率失效
        vm.prank(alice);
        vm.expectRevert(bytes("invalid PoW"));
        token.mint(nonce);
    }

    function test_HalvingApplied() public {
        // 借助 stdStorage 设定 totalMints 接近第二 era 的边界，避免真的挖 100k 次
        stdstore.target(address(token)).sig("totalMints()").checked_write(uint256(100_000 - 1));

        assertEq(token.currentEra(), 0);
        assertEq(token.currentReward(), 100 * 1e18);

        uint256 n1 = _findNonce(alice, 0);
        vm.prank(alice);
        token.mint(n1);
        // mint 后 totalMints = 100000 → era=1, reward = 50
        assertEq(token.currentEra(), 1);
        assertEq(token.currentReward(), 50 * 1e18);
        // 上一次 mint 拿到的是当时（era=0）的 reward = 100
        assertEq(token.balanceOf(alice), 100 * 1e18);

        // 下一次 mint 拿到的是 50
        // 需要换 block 防 cap，并换 nonce（usedDigest）
        vm.roll(block.number + 1);
        uint256 n2 = _findNonce(alice, n1 + 1);
        vm.prank(alice);
        token.mint(n2);
        assertEq(token.balanceOf(alice), (100 + 50) * 1e18);
    }

    function test_DifficultyAdjustsTighter_WhenMintingFast() public {
        // 把 mintsInWindow 设到刚好差 1 就触发调整
        stdstore.target(address(token)).sig("mintsInWindow()").checked_write(
            uint256(token.ADJUST_INTERVAL() - 1)
        );
        // windowStartTime 设为很近的过去 -> elapsed 远小于 expected -> 难度变紧（target 变小）
        stdstore.target(address(token)).sig("windowStartTime()").checked_write(
            uint256(block.timestamp)
        );

        // 跳 1 秒，远小于 expected = 2016 * 60 = 120,960s
        vm.warp(block.timestamp + 1);

        uint256 nonce = _findNonce(alice, 0);
        uint256 oldTarget = token.currentTarget();
        vm.prank(alice);
        token.mint(nonce);

        uint256 newTarget = token.currentTarget();
        assertLt(newTarget, oldTarget, "target should tighten");
        // ±4× clamp：actual 被 clamp 为 expected/4，新 target = old / 4
        assertEq(newTarget, oldTarget / 4);
    }

    function test_DifficultyAdjustsLooser_WhenMintingSlow() public {
        stdstore.target(address(token)).sig("mintsInWindow()").checked_write(
            uint256(token.ADJUST_INTERVAL() - 1)
        );
        stdstore.target(address(token)).sig("windowStartTime()").checked_write(
            uint256(block.timestamp)
        );

        // 跳极长时间 -> 被 clamp 到 expected*4 -> 新 target = old * 4
        uint256 expected = token.ADJUST_INTERVAL() * token.TARGET_INTERVAL();
        vm.warp(block.timestamp + expected * 100);

        uint256 nonce = _findNonce(alice, 0);
        uint256 oldTarget = token.currentTarget();
        vm.prank(alice);
        token.mint(nonce);

        uint256 newTarget = token.currentTarget();
        assertGt(newTarget, oldTarget, "target should loosen");
        assertEq(newTarget, oldTarget * 4);
    }

    function test_SupplyCapEnforced() public {
        // 设 totalSupply 到接近 cap
        uint256 nearCap = token.MAX_SUPPLY() - 1;
        // OpenZeppelin ERC20: _totalSupply 在 slot 2
        bytes32 slot = bytes32(uint256(2));
        vm.store(address(token), slot, bytes32(nearCap));
        assertEq(token.totalSupply(), nearCap);

        uint256 nonce = _findNonce(alice, 0);
        vm.prank(alice);
        token.mint(nonce);

        // 应当只 mint 出 1 wei 而不是完整 reward
        assertEq(token.totalSupply(), token.MAX_SUPPLY());
        assertEq(token.balanceOf(alice), 1);

        // 再来一次应直接 revert
        vm.roll(block.number + 1);
        uint256 nonce2 = _findNonce(alice, nonce + 1);
        vm.prank(alice);
        vm.expectRevert(bytes("supply capped"));
        token.mint(nonce2);
    }

    function test_DigestOfMatchesMintPath() public view {
        bytes32 challenge = token.challengeOf(alice);
        bytes32 d1 = keccak256(abi.encodePacked(challenge, uint256(42)));
        bytes32 d2 = token.digestOf(alice, 42, token.currentEpoch());
        assertEq(d1, d2);
    }
}
