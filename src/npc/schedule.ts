/**
 * Routine lookup — "where would this person be right now if nobody interfered".
 *
 * The profiler surfaces this verbatim as the pattern-of-life panel, and the
 * behaviour tick uses it as the baseline that impulses displace. Keeping one
 * implementation for both means the schedule you read is genuinely the schedule
 * the NPC obeys.
 */

import type { Instant } from "../core/time.js";
import { MINUTES_PER_DAY, dayOf, minuteOfDay, windowContains, windowLength } from "../core/time.js";
import type { Npc, RoutineBlock } from "./types.js";

/** Day of week, 0 = the first day of the run. */
export function weekdayOf(t: Instant): number {
  return dayOf(t) % 7;
}

function appliesToday(block: RoutineBlock, t: Instant): boolean {
  if (!block.days || block.days.length === 0) return true;
  return block.days.includes(weekdayOf(t));
}

/** The block covering `t`, or undefined if the routine has a gap. */
export function blockAt(npc: Npc, t: Instant): RoutineBlock | undefined {
  for (const block of npc.routine) {
    if (appliesToday(block, t) && windowContains(block.window, t)) return block;
  }
  return undefined;
}

/** Where the routine says they should be, falling back to home. */
export function scheduledPlace(npc: Npc, t: Instant): string {
  return blockAt(npc, t)?.placeId ?? npc.homePlaceId;
}

/** Minutes until the current block ends (or until the next one begins). */
export function minutesLeftInBlock(npc: Npc, t: Instant): number {
  const block = blockAt(npc, t);
  if (!block) return 15;
  const now = minuteOfDay(t);
  const end = block.window.endMinute;
  const delta = (end - now + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return delta === 0 ? windowLength(block.window) : delta;
}

/** The next `count` blocks starting from `t`, for the pattern-of-life readout. */
export function upcoming(npc: Npc, t: Instant, count: number): Array<{ at: Instant; block: RoutineBlock }> {
  const out: Array<{ at: Instant; block: RoutineBlock }> = [];
  let cursor = t;
  let guard = 0;
  while (out.length < count && guard++ < 64) {
    const block = blockAt(npc, cursor);
    if (block) {
      const last = out[out.length - 1];
      if (!last || last.block.id !== block.id) out.push({ at: cursor, block });
      cursor += Math.max(1, minutesLeftInBlock(npc, cursor));
    } else {
      cursor += 15;
    }
  }
  return out;
}

/** Is this person on a post they are not supposed to leave, right now? */
export function onPost(npc: Npc, t: Instant): boolean {
  return blockAt(npc, t)?.post === true;
}
