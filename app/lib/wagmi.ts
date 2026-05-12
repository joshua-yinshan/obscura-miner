import { http, createConfig } from "wagmi";
import { baseSepolia, sepolia, hardhat } from "wagmi/chains";
import { injected } from "wagmi/connectors";

const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 84532);
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

function pickChain() {
  if (chainId === 84532) return baseSepolia;
  if (chainId === 11155111) return sepolia;
  if (chainId === 31337) return hardhat;
  return baseSepolia;
}

export const activeChain = pickChain();

// 同时声明三条链，所以 chains 与 transports 的类型一致。
// 用户钱包实际连哪条由 MetaMask 决定，activeChain 只用于默认显示/校验。
export const wagmiConfig = createConfig({
  chains: [baseSepolia, sepolia, hardhat],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [baseSepolia.id]: http(
      chainId === baseSepolia.id && rpcUrl ? rpcUrl : baseSepolia.rpcUrls.default.http[0],
    ),
    [sepolia.id]: http(
      chainId === sepolia.id && rpcUrl ? rpcUrl : sepolia.rpcUrls.default.http[0],
    ),
    [hardhat.id]: http(
      chainId === hardhat.id && rpcUrl ? rpcUrl : hardhat.rpcUrls.default.http[0],
    ),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
