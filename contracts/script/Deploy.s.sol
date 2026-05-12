// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MineableToken} from "../src/MineableToken.sol";

/**
 * @title Deploy MineableToken
 *
 * 用法（Base Sepolia 示例）：
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url $BASE_SEPOLIA_RPC_URL \
 *     --broadcast \
 *     --verify \
 *     -vvv
 *
 * 通过环境变量调整难度：
 *   INITIAL_TARGET=240   →  target = 2**240（中等难度）
 *   INITIAL_TARGET=248   →  target = 2**248（极易，适合 demo）
 *   INITIAL_TARGET=236   →  target = 2**236（较难）
 */
contract Deploy is Script {
    function run() external returns (MineableToken token) {
        uint256 pk = vm.envUint("PRIVATE_KEY");

        // 默认 2**244 —— 浏览器单核 100kh/s 大约 1-2 秒一次命中，demo 友好
        uint256 shift = vm.envOr("INITIAL_TARGET", uint256(244));
        require(shift > 0 && shift < 256, "shift must be in (0, 256)");
        uint256 initialTarget = uint256(1) << shift;

        vm.startBroadcast(pk);
        token = new MineableToken(initialTarget);
        vm.stopBroadcast();

        console2.log("=========================================");
        console2.log("MineableToken deployed at:", address(token));
        console2.log("Initial target (shift):", shift);
        console2.log("Initial target (value):", initialTarget);
        console2.log("Launch time:", token.launchTime());
        console2.log("=========================================");
    }
}
