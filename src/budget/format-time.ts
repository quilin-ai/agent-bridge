/**
 * Beijing-time (UTC+8 / Asia/Shanghai) formatting for ALL user-facing budget
 * timestamps.
 *
 * The user reads budget output in Beijing time, so every reset/resume timestamp
 * the bridge renders (get_budget text, budget coordination notices, pause /
 * admission gate errors) MUST go through here — never `toISOString()` (UTC) or
 * `getHours()` (host-local, wrong on a non-Beijing host). This is enforced in
 * code, not by per-session memory, so it holds in every project.
 */

const BEIJING_TZ = "Asia/Shanghai";

/** Short label callers can append once per surface to disambiguate. */
export const BEIJING_TZ_LABEL = "北京时间";

function parts(
  epochSeconds: number,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: BEIJING_TZ,
    hour12: false,
    ...options,
  });
  const out: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(epochSeconds * 1000))) {
    out[part.type] = part.value;
  }
  return out;
}

/**
 * Format an epoch (seconds) as 「YYYY-MM-DD HH:MM」 in Beijing time. Returns
 * 「未知」 for missing/invalid input. No timezone suffix — callers add the
 * `北京时间` label once per surface so repeated timestamps stay readable.
 */
export function formatBeijing(epochSeconds: number | null | undefined): string {
  if (!epochSeconds || epochSeconds <= 0) return "未知";
  const d = new Date(epochSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "未知";
  const p = parts(epochSeconds, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  // en-CA yields ISO-ish 「2026-06-18」 for the date part; recompose explicitly.
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Format an epoch (seconds) as a Beijing-time wall clock 「HH:MM」. */
export function formatBeijingClock(epochSeconds: number | null | undefined): string {
  if (!epochSeconds || epochSeconds <= 0) return "未知";
  const d = new Date(epochSeconds * 1000);
  if (Number.isNaN(d.getTime())) return "未知";
  const p = parts(epochSeconds, { hour: "2-digit", minute: "2-digit" });
  return `${p.hour}:${p.minute}`;
}
