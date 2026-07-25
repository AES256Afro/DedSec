/**
 * The world event log.
 *
 * Everything observable that happens gets appended here: an NPC leaving a post,
 * a door unlocking, a forged text landing, an ambulance dispatching. Three
 * different consumers read the same log, which is why it is a log and not a
 * pile of callbacks:
 *
 *  - the UI feed, which shows the player what the city just did;
 *  - the mission runtime, which evaluates objectives against history;
 *  - the forensics pass, which reconstructs what an investigator could infer.
 */

import type { Instant } from "./time.js";

export type EventChannel =
  | "world" // ambient city activity
  | "npc" // an NPC did something
  | "hack" // the player touched the network
  | "social" // manipulation landed, was doubted, or backfired
  | "security" // guards, alarms, investigations
  | "emergency" // medical / fire / dispatch
  | "mission"; // objective progress

/** How loudly this event should read in the player's feed. */
export type EventTone = "info" | "good" | "warn" | "bad";

export interface WorldEvent {
  id: number;
  at: Instant;
  channel: EventChannel;
  /** Stable machine-readable discriminator, e.g. "npc.left_post". */
  kind: string;
  /** One line of player-facing prose. */
  text: string;
  tone: EventTone;
  /** Entity ids this event concerns — used for filtering and forensics. */
  subjects: string[];
  /** Whether this event is attributable to the player if anyone looks. */
  traceable: boolean;
  data?: Record<string, unknown>;
}

export interface EmitOptions {
  channel: EventChannel;
  kind: string;
  text: string;
  tone?: EventTone;
  subjects?: string[];
  traceable?: boolean;
  data?: Record<string, unknown>;
}

export type EventListener = (event: WorldEvent) => void;

export class EventLog {
  private events: WorldEvent[] = [];
  private listeners = new Set<EventListener>();
  private nextId = 1;
  /** Ring-buffer cap; forensics only ever needs the recent past. */
  private readonly capacity: number;

  constructor(capacity = 4000) {
    this.capacity = capacity;
  }

  emit(at: Instant, options: EmitOptions): WorldEvent {
    const event: WorldEvent = {
      id: this.nextId++,
      at,
      channel: options.channel,
      kind: options.kind,
      text: options.text,
      tone: options.tone ?? "info",
      subjects: options.subjects ?? [],
      traceable: options.traceable ?? false,
      ...(options.data ? { data: options.data } : {}),
    };
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  all(): readonly WorldEvent[] {
    return this.events;
  }

  /** Most recent first. */
  recent(count: number, filter?: (e: WorldEvent) => boolean): WorldEvent[] {
    const out: WorldEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < count; i--) {
      const e = this.events[i]!;
      if (!filter || filter(e)) out.push(e);
    }
    return out;
  }

  since(t: Instant): WorldEvent[] {
    return this.events.filter((e) => e.at >= t);
  }

  /** Did anything matching `kind` involving `subject` happen at or after `t`? */
  happened(kind: string, subject?: string, t = 0): boolean {
    return this.events.some(
      (e) => e.kind === kind && e.at >= t && (!subject || e.subjects.includes(subject)),
    );
  }

  find(kind: string, subject?: string): WorldEvent | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!;
      if (e.kind === kind && (!subject || e.subjects.includes(subject))) return e;
    }
    return undefined;
  }
}
