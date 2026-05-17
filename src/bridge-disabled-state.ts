export type BridgeDisabledReason = "killed" | "rejected" | "daemon_rejected_attach";

export function disabledReplyError(reason: BridgeDisabledReason): string {
  switch (reason) {
    case "rejected":
      return "AgentBridge rejected this session — another Claude Code session is already connected. Close the other session first, or run `agentbridge kill` to reset.";
    case "killed":
      return "AgentBridge is disabled by `agentbridge kill`. Restart Claude Code (`agentbridge claude`), switch to a new conversation, or run `/resume` to reconnect.";
    case "daemon_rejected_attach":
      // STM v2.3 §D4 / §D6 P4-cleanup: daemon returned ok=false from
      // claude_connect_result (PAIR_NOT_FOUND / PAIR_BUSY / INVALID_PAIR_NAME).
      // The detailed error+message has already been pushed as a system
      // notification when the rejection happened; this string is the
      // fallback shown if reply tool is called before the user reads it.
      return "AgentBridge could not attach this Claude session — the daemon rejected the pair binding. See the most recent system message for the specific error (PAIR_NOT_FOUND / PAIR_BUSY / INVALID_PAIR_NAME). Restart Claude Code after fixing the underlying issue.";
  }
}
