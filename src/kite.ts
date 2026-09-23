/**
 * Kite network constants adapted from gokite-ai/kite-x402-services,
 * templates/typescript-express/src/kite.ts (Apache-2.0). See NOTICE.
 */
import type { AssetAmount, Network } from "@x402/core/types";

export type KiteNetworkName = "testnet" | "mainnet";

export interface KiteChain {
  network: Network;
  assetAddress: string;
  assetSymbol: string;
  assetDecimals: number;
  eip712Name: string;
  eip712Version: string;
}

export const KITE_MAINNET: Readonly<KiteChain> = Object.freeze({
  network: "eip155:2366",
  assetAddress: "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e",
  assetSymbol: "USDC.e",
  assetDecimals: 6,
  eip712Name: "Bridged USDC (Kite AI)",
  eip712Version: "2",
});

export const KITE_TESTNET: Readonly<KiteChain> = Object.freeze({
  network: "eip155:2368",
  assetAddress: "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A",
  assetSymbol: "pieUSD",
  assetDecimals: 18,
  eip712Name: "pieUSD",
  eip712Version: "1",
});

export const FACILITATOR_URL = "https://facilitator.pieverse.io/v2";

export function kiteChainByName(name: KiteNetworkName): Readonly<KiteChain> {
  if (name === "testnet") return KITE_TESTNET;
  if (name === "mainnet") return KITE_MAINNET;
  throw new Error("KITE_NETWORK must be testnet or mainnet");
}

/**
 * Restrict dollar prices to six decimals on both networks. No floating-point
 * arithmetic or SDK money parsing is involved; even testnet's 18-decimal units
 * are calculated exactly from the configuration string.
 */
export function kitePriceAmount(priceUsd: string, chain: Readonly<KiteChain>): AssetAmount {
  if (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/.test(priceUsd)) {
    throw new Error("PRICE_USD must be a positive decimal with at most six fractional digits");
  }
  const [whole = "0", fractional = ""] = priceUsd.split(".");
  const amount = BigInt(whole + fractional.padEnd(chain.assetDecimals, "0"));
  if (amount <= 0n) throw new Error("PRICE_USD must be greater than zero");
  return {
    asset: chain.assetAddress,
    amount: amount.toString(),
    extra: { name: chain.eip712Name, version: chain.eip712Version },
  };
}
