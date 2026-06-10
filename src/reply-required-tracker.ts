/**
 * Coordinates the `require_reply` state for a single Codex turn.
 *
 * When Claude sends a reply with `require_reply`, the daemon must:
 *   (a) force-forward EVERY subsequent Codex message to Claude (bypassing the
 *       STATUS/FYI message filter) until the turn completes, and
 *   (b) warn if the turn finishes without Codex sending any agentMessage.
 *
 * CRITICAL ordering invariant: `arm()` must be called ONLY after the message was
 * successfully injected (a turn actually started). Arming before a *rejected*
 * injection — the common case where Codex is busy mid-turn — would strand the
 * armed state on an unrelated in-flight turn: that unrelated turn's chatter would
 * be force-forwarded as if it were the required reply, and when it completes the
 * "reply missing" warning would be wrongly skipped, silently losing Claude's real
 * require_reply request. Keeping the arm/consume/reset transitions in one place
 * makes that invariant explicit and testable.
 */
export class ReplyRequiredTracker {
  private armed = false;
  private forwardedDuringTurn = false;

  /** True while a require_reply turn is in flight (force-forward is active). */
  get isArmed(): boolean {
    return this.armed;
  }

  /** Arm tracking for a require_reply turn that was successfully injected. */
  arm(): void {
    this.armed = true;
    this.forwardedDuringTurn = false;
  }

  /** Record that a Codex message was force-forwarded to Claude during the turn. */
  noteForwarded(): void {
    if (this.armed) this.forwardedDuringTurn = true;
  }

  /**
   * Consume at turn completion: returns whether to emit the "reply required but
   * none arrived" warning, then clears the state.
   */
  consumeOnTurnComplete(): { warnReplyMissing: boolean } {
    const warnReplyMissing = this.armed && !this.forwardedDuringTurn;
    this.reset();
    return { warnReplyMissing };
  }

  /** Clear without warning (e.g. disconnect / reconnect / shutdown). */
  reset(): void {
    this.armed = false;
    this.forwardedDuringTurn = false;
  }
}
