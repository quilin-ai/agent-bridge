import { describe, expect, test } from "bun:test";
import { BudgetCoordinator } from "../budget/budget-coordinator";
import type { AgentUsage, BudgetConfig } from "../budget/types";

const NOW = 1_700_000_000;

const CONFIG: BudgetConfig = {
  enabled: true,
  pollSeconds: 0.01,
  pauseAt: 90,
  resumeBelow: 30,
  syncDriftPct: 10,
  parallel: {
    minRemainingPct: 60,
    timeWindowSec: 3600,
  },
  codexTierControl: false,
};

type FetchResult = { claude: AgentUsage | null; codex: AgentUsage | null } | null;

function usage(overrides: Partial<AgentUsage> = {}): AgentUsage {
  const gateUtil = overrides.gateUtil ?? 20;
  const warnUtil = overrides.warnUtil ?? gateUtil;
  return {
    ok: true,
    stale: false,
    gateUtil,
    warnUtil,
    fiveHour: { util: gateUtil, resetEpoch: NOW + 3600 },
    weekly: { util: warnUtil, resetEpoch: NOW + 500_000 },
    remaining: 100 - gateUtil,
    rateLimitedUntil: 0,
    fetchedAt: NOW,
    ...overrides,
  };
}

class FakeSource {
  calls = 0;
  private last: FetchResult;

  constructor(private readonly results: FetchResult[]) {
    this.last = results[results.length - 1] ?? null;
  }

  async fetchBoth(): Promise<FetchResult> {
    const result = this.results[this.calls] ?? this.last;
    this.calls += 1;
    this.last = result;
    return result;
  }
}

function makeCoordinator(source: FakeSource) {
  const emitted: Array<{ id: string; content: string }> = [];
  const pauseChanges: boolean[] = [];
  const coordinator = new BudgetCoordinator({
    source,
    config: CONFIG,
    emit: (id, content) => emitted.push({ id, content }),
    onPauseChange: (paused) => pauseChanges.push(paused),
    now: () => NOW,
  });

  return { coordinator, emitted, pauseChanges };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(5);
  }
  throw new Error("condition was not met before timeout");
}

describe("BudgetCoordinator", () => {
  test("start immediately polls and stores the first snapshot", async () => {
    const source = new FakeSource([{ claude: usage(), codex: usage({ gateUtil: 21, warnUtil: 21 }) }]);
    const { coordinator, emitted } = makeCoordinator(source);

    await coordinator.start();
    coordinator.stop();

    expect(source.calls).toBe(1);
    expect(coordinator.getSnapshot()).toMatchObject({
      phase: "normal",
      updatedAt: NOW,
      paused: false,
      codexTier: "full",
    });
    expect(coordinator.isPaused()).toBe(false);
    expect(coordinator.getCodexTurnOverrides()).toBeNull();
    expect(emitted).toEqual([]);
  });

  test("deduplicates repeated directives with the same phase fingerprint", async () => {
    const source = new FakeSource([
      { claude: usage({ warnUtil: 45 }), codex: usage({ gateUtil: 20, warnUtil: 20 }) },
      { claude: usage({ warnUtil: 45 }), codex: usage({ gateUtil: 20, warnUtil: 20 }) },
    ]);
    const { coordinator, emitted } = makeCoordinator(source);

    await coordinator.start();
    await waitFor(() => source.calls >= 2);
    coordinator.stop();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].id).toStartWith("system_budget_balance");
    expect(emitted[0].content).toContain("用量比例漂移");
  });

  test("emits pause and resume on pause lifecycle edges", async () => {
    const source = new FakeSource([
      { claude: usage(), codex: usage() },
      { claude: usage({ gateUtil: 91, warnUtil: 91, remaining: 9 }), codex: usage() },
      { claude: usage({ gateUtil: 50, warnUtil: 50, remaining: 50 }), codex: usage() },
      { claude: usage({ gateUtil: 20, warnUtil: 20, remaining: 80 }), codex: usage() },
    ]);
    const { coordinator, emitted, pauseChanges } = makeCoordinator(source);

    await coordinator.start();
    await waitFor(() => emitted.some((event) => event.id.startsWith("system_budget_pause")));
    expect(coordinator.isPaused()).toBe(true);
    await waitFor(() => source.calls >= 3);
    expect(coordinator.isPaused()).toBe(true);
    expect(emitted.some((event) => event.id.startsWith("system_budget_resume"))).toBe(false);
    await waitFor(() => emitted.some((event) => event.id.startsWith("system_budget_resume")));
    coordinator.stop();

    expect(pauseChanges).toEqual([true, false]);
    expect(emitted.map((event) => event.id.split("_").slice(0, 3).join("_"))).toContain("system_budget_pause");
    const resume = emitted.find((event) => event.id.startsWith("system_budget_resume"));
    expect(resume?.content).toContain("联合暂停解除");
    expect(resume?.content).toContain("reply");
    expect(resume?.content).toContain("唤醒 Codex");
    expect(coordinator.getSnapshot()?.paused).toBe(false);
  });

  test("re-emits a pause after coordinator reconstruction", async () => {
    const firstSource = new FakeSource([
      { claude: usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }), codex: usage() },
    ]);
    const first = makeCoordinator(firstSource);

    await first.coordinator.start();
    first.coordinator.stop();

    const secondSource = new FakeSource([
      { claude: usage({ gateUtil: 92, warnUtil: 92, remaining: 8 }), codex: usage() },
    ]);
    const second = makeCoordinator(secondSource);

    await second.coordinator.start();
    second.coordinator.stop();

    expect(first.emitted.filter((event) => event.id.startsWith("system_budget_pause"))).toHaveLength(1);
    expect(second.emitted.filter((event) => event.id.startsWith("system_budget_pause"))).toHaveLength(1);
    expect(first.pauseChanges).toEqual([true]);
    expect(second.pauseChanges).toEqual([true]);
  });

  test("stop cancels scheduled polling timers", async () => {
    const source = new FakeSource([{ claude: usage(), codex: usage() }]);
    const { coordinator } = makeCoordinator(source);

    await coordinator.start();
    coordinator.stop();
    await sleep(30);

    expect(source.calls).toBe(1);
  });

  test("pauses on rate-limited-only usage", async () => {
    const source = new FakeSource([
      {
        claude: usage({
          ok: false,
          gateUtil: 0,
          warnUtil: 0,
          remaining: 100,
          rateLimitedUntil: NOW + 900,
          fiveHour: null,
          weekly: null,
        }),
        codex: usage(),
      },
    ]);
    const { coordinator, emitted, pauseChanges } = makeCoordinator(source);

    await coordinator.start();
    coordinator.stop();

    expect(coordinator.isPaused()).toBe(true);
    expect(coordinator.getSnapshot()?.resumeAfterEpoch).toBe(NOW + 900);
    expect(pauseChanges).toEqual([true]);
    expect(emitted[0].id).toStartWith("system_budget_pause");
    expect(emitted[0].content).toContain("限流");
  });

  test("keeps working when one side probe is unavailable", async () => {
    const source = new FakeSource([{ claude: null, codex: usage() }]);
    const { coordinator, emitted, pauseChanges } = makeCoordinator(source);

    await coordinator.start();
    coordinator.stop();

    expect(coordinator.getSnapshot()).toMatchObject({
      phase: "normal",
      claude: null,
      paused: false,
    });
    expect(emitted).toEqual([]);
    expect(pauseChanges).toEqual([]);
  });
});
