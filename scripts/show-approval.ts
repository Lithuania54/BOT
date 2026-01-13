import { AssetType } from "@polymarket/clob-client";
import { loadConfig } from "../src/config";
import { initClobClients } from "../src/clob";
import { formatUsdcMicro, parseUsdcToMicro } from "../src/preflight";

const USDCe_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF_SPENDER_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";

function getAllowanceOwner(config: { signatureType: number; funderAddress?: string; myUserAddress: string }): string {
  if (config.signatureType === 1 || config.signatureType === 2) {
    return config.funderAddress || config.myUserAddress;
  }
  return config.myUserAddress;
}

async function main() {
  const config = loadConfig();
  const { tradingClient } = await initClobClients(config);
  if (!tradingClient) {
    throw new Error("Trading client not initialized. Check API key settings.");
  }

  const balance = await tradingClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  const allowanceMicro = parseUsdcToMicro(balance?.allowance);
  const funderOwner = getAllowanceOwner(config);

  const payload = {
    funderAddress: funderOwner,
    token: USDCe_ADDRESS,
    spender: CTF_SPENDER_ADDRESS,
    allowance: formatUsdcMicro(allowanceMicro),
    note:
      config.signatureType === 2
        ? "Proxy wallets must approve in the Polymarket UI; AUTO_APPROVE is not supported."
        : "If allowance is low, approve USDC.e for the CTF spender.",
  };

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
