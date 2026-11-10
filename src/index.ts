export { agentxWatch, agentxWatchAll } from "./wrap";
export type { WatchableTool, WatchOptions } from "./wrap";
export type { Action, TargetClass } from "./shape";
export {
  agentxProtect, agentxProtectAll, isBlock, isUnconfirmed, blockDetails, recordSpend, startSecureSession, agentxSession,
  AgentXCircuitBreakerTripped,
} from "./protect";
export type { ProtectOptions, BlockDetails } from "./protect";
