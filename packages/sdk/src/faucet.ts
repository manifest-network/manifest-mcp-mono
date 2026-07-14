// `/faucet` subpath — testnet faucet ops (browser-safe: pure fetch + zod). Sourced
// from core's universal `/faucet` subpath. Deliberately OFF the SDK root barrel —
// faucet is a testnet/operator concern, exposed only here (ENG-446 M7, ENG-531).
export {
  type FaucetAccount,
  type FaucetDripResult,
  type FaucetStatusResponse,
  fetchFaucetStatus,
  type RequestFaucetResult,
  requestFaucet,
  requestFaucetCredit,
} from '@manifest-network/manifest-mcp-core/faucet';
