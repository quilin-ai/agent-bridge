import { findLatestClaudeSession } from "../claude-session";
import { parsePairFlag, resolvePairReadOnly } from "../pair-resolver";
import { readUsableCurrentThread } from "../thread-state";

/**
 * `abg resume` — one place to get back to where the pair left off.
 *
 *   abg resume          print the resume commands for this directory's last
 *                       Claude Code session and this pair's current Codex thread
 *   abg resume claude   resume the last Claude Code session here, directly
 *   abg resume codex    resume this pair's verified current Codex thread, directly
 *
 * Direct modes delegate to the regular launchers, so pair resolution, conflict
 * guards and the max-permission defaults all apply exactly as for
 * `abg claude` / `abg codex`.
 */
export interface ResumeTargets {
  pairName: string;
  claudeSessionId: string | null;
  codexThreadId: string | null;
}

export function resolveResumeTargets(opts: {
  pairFlag?: string;
  claudeHome?: string;
  env?: NodeJS.ProcessEnv;
} = {}): ResumeTargets {
  // Pair resolution (resolvePairReadOnly) is hard-wired to process.cwd(), so
  // the thread identity must use the same cwd — a parameterized cwd here would
  // silently mismatch the pair's recorded thread state.
  const cwd = process.cwd();
  const { pair } = resolvePairReadOnly(opts.pairFlag);
  const claude = findLatestClaudeSession(cwd, opts.claudeHome);
  const codex = readUsableCurrentThread(
    {
      stateDir: pair.stateDir,
      pairId: pair.manual ? null : pair.pairId,
      pairName: pair.name,
      cwd,
    },
    opts.env ?? process.env,
  );
  return {
    pairName: pair.name,
    claudeSessionId: claude?.sessionId ?? null,
    codexThreadId: codex?.threadId ?? null,
  };
}

export async function runResume(args: string[]) {
  const { pairFlag, rest } = parsePairFlag(args);
  const target = rest[0];
  const extra = rest.slice(1);
  // `!== undefined`, NOT truthiness: parsePairFlag maps a value-less `--pair`
  // to "" precisely so resolution throws PAIR_ID_INVALID downstream — a
  // truthy check would silently fall back to the default pair, diverging from
  // every other launcher.
  const pairPrefix = pairFlag !== undefined ? ["--pair", pairFlag] : [];

  if (target === "claude") {
    const session = findLatestClaudeSession(process.cwd());
    if (!session) {
      console.error("[agentbridge] No Claude Code session found for this directory.");
      console.error("[agentbridge] Start one with: abg claude");
      process.exit(1);
    }
    console.error(`[agentbridge] Resuming Claude Code session ${session!.sessionId}`);
    const { runClaude } = await import("./claude");
    await runClaude([...pairPrefix, "--resume", session!.sessionId, ...extra]);
    return;
  }

  if (target === "codex") {
    // resume-current verifies the pair's recorded thread (rollout file must
    // exist) and fails loudly when there is none — exactly the semantics we
    // want for "get me back to the last Codex session".
    const { runCodex } = await import("./codex");
    await runCodex([...pairPrefix, "resume-current", ...extra]);
    return;
  }

  if (target !== undefined) {
    console.error(`Error: unknown resume target "${target}".`);
    console.error("");
    console.error("Usage:");
    console.error("  abg resume           # print resume commands for this directory");
    console.error("  abg resume claude    # resume the last Claude Code session here");
    console.error("  abg resume codex     # resume this pair's current Codex thread");
    process.exit(1);
  }

  const targets = resolveResumeTargets({ pairFlag });
  const pairArg = pairFlag ? `--pair ${pairFlag} ` : "";

  const lines: string[] = [];
  if (targets.claudeSessionId) {
    lines.push(`abg ${pairArg}claude --resume ${targets.claudeSessionId}`);
  } else {
    lines.push(`# no Claude Code session found for this directory (start one: abg ${pairArg}claude)`);
  }
  if (targets.codexThreadId) {
    lines.push(`abg ${pairArg}codex resume ${targets.codexThreadId}`);
  } else {
    lines.push(`# no verified Codex thread for pair "${targets.pairName}" (start one: abg ${pairArg}codex --new)`);
  }
  console.log(lines.join("\n"));
  console.error("");
  console.error("Tip: `abg resume claude` / `abg resume codex` runs these directly.");
  console.error("(max-permission flags are applied by default; opt out with --safe or AGENTBRIDGE_SAFE=1)");

  if (!targets.claudeSessionId && !targets.codexThreadId) {
    process.exit(1);
  }
}
