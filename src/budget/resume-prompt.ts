export const RESUME_PROMPT =
  "额度窗口已刷新，继续上次未完成的任务：从 .agent/checkpoint.md 的「下一步」接着做；完成后停下并标 DONE。";

/**
 * Claude-side resume directive (PR4 channel push). Unlike the Codex variant
 * (injected as a turn), this is delivered as a channel notification carrying a
 * stable `resumeId`. The daemon re-pushes it until Claude acks via the
 * `ack_resume` MCP tool, so the wording MUST make clear the ack means RECEIVED
 * (call it immediately), NOT FINISHED — a long task (>60s) would otherwise keep
 * triggering re-pushes if Claude waited until completion to ack.
 */
export function claudeResumePrompt(resumeId: string): string {
  return (
    "额度窗口已刷新。" +
    `请先调用 ack_resume(resume_id="${resumeId}", status="resumed") 确认已收到本通知（ACK = 已接收，不是完成，请立即调用，不要等任务做完），` +
    "再从 .agent/checkpoint.md 的「下一步」接着做；完成后停下并标 DONE。"
  );
}
