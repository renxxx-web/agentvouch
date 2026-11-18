// AgentVouch — deployment configuration.
// ============================================================
// FILL IN AFTER DEPLOYMENT:
//   CONTRACT_ADDRESS — the deployed AgentVouch contract address.
//   EVENT_FROM_BLOCK — the block the contract was deployed in
//                      (the wall and leaderboard scan events from
//                      here; 0 = scan a recent window only).
// Until CONTRACT_ADDRESS is set, the site runs in preview mode:
// the interface loads, but on-chain reads/writes are disabled.
// ============================================================
const CONFIG = {
  CONTRACT_ADDRESS: "0x7452a297b387588d5b082392dc57d3ccd908b48a", // PLACEHOLDER — replace after deployment
  EVENT_FROM_BLOCK: 134311441, // PLACEHOLDER — replace with the deployment block

  // Agent ID registry (real, BSC mainnet) — do not change.
  REGISTRY_ADDRESS: "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F",

  CHAIN_ID: 56, // BNB Smart Chain mainnet
  CHAIN_NAME: "BNB Smart Chain",
  RPCS: [
    "https://bsc-dataseed.binance.org",
    "https://bsc.publicnode.com"
  ],
  EXPLORER: "https://bscscan.com",

  // Event scanning: blocks are fetched backwards in chunks.
  LOG_CHUNK: 4500,          // blocks per eth_getLogs call
  LOG_MAX_CHUNKS: 60        // hard cap on chunks per scan
};
