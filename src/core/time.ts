/**
 * World clock.
 *
 * The simulation advances in whole world-minutes. Everything scheduled in the
 * game — routines, deliveries, shift changes, ambulance ETAs — is expressed in
 * minutes since world start, so there is exactly one notion of "when".
 */

export const MINUTES_PER_HOUR = 60;
export const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

/** Minutes elapsed since 00:00 on day 0. */
export type Instant = number;

export interface Clock {
  /** Minutes since world start. */
  now: Instant;
}

export function dayOf(t: Instant): number {
  return Math.floor(t / MINUTES_PER_DAY);
}

/** Minutes since local midnight, always in [0, 1440). */
export function minuteOfDay(t: Instant): number {
  return ((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

export function hourOf(t: Instant): number {
  return Math.floor(minuteOfDay(t) / MINUTES_PER_HOUR);
}

/** Build an instant from a day index and a wall-clock time. */
export function at(day: number, hour: number, minute = 0): Instant {
  return day * MINUTES_PER_DAY + hour * MINUTES_PER_HOUR + minute;
}

/**
 * "07:45" style formatting of the time-of-day component.
 *
 * Instants are not always whole minutes — verb costs advance the clock by
 * fractions — so this floors before splitting rather than trusting the input.
 */
export function formatTime(t: Instant): string {
  const m = Math.floor(minuteOfDay(t));
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function formatDateTime(t: Instant): string {
  return `D${dayOf(t) + 1} ${formatTime(t)}`;
}

/** Human-friendly gap, e.g. "in 2h 15m" / "12m ago". */
export function formatOffset(from: Instant, to: Instant): string {
  const delta = to - from;
  const abs = Math.round(Math.abs(delta));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const body = h > 0 ? `${h}h ${m}m` : `${m}m`;
  if (delta === 0) return "now";
  return delta > 0 ? `in ${body}` : `${body} ago`;
}

/**
 * Half-open wall-clock window that may wrap past midnight (a 22:00-04:00 bar
 * shift is one window, not two).
 */
export interface DayWindow {
  startMinute: number;
  endMinute: number;
}

export function windowContains(w: DayWindow, t: Instant): boolean {
  const m = minuteOfDay(t);
  if (w.startMinute <= w.endMinute) return m >= w.startMinute && m < w.endMinute;
  return m >= w.startMinute || m < w.endMinute;
}

export function windowLength(w: DayWindow): number {
  const raw = w.endMinute - w.startMinute;
  return raw >= 0 ? raw : raw + MINUTES_PER_DAY;
}

/** Next instant at or after `t` at which the window opens. */
export function nextWindowStart(w: DayWindow, t: Instant): Instant {
  const base = dayOf(t) * MINUTES_PER_DAY + w.startMinute;
  return base >= t ? base : base + MINUTES_PER_DAY;
}
