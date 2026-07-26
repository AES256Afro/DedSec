/**
 * The one console handle, shared by both clients.
 *
 * Two entry points now attach to `window.dedsec` — the field terminal and the
 * street client — and TypeScript merges `declare global` blocks rather than
 * letting the second one win. Declaring the shape once, here, is what stops the
 * two clients from having to agree on a surface neither of them needs from the
 * other: each fills in the members it has, the smoke tests check for what they
 * use, and everything is optional because in any given page most of it is.
 *
 * Nothing in here is a back door. Every field is a reference to the same objects
 * the UI already drives through `src/sim/actions.ts`.
 */

import type { GameState } from "../src/sim/state.js";

declare global {
  interface Window {
    dedsec: {
      /** The live world. Both clients. */
      state: () => GameState;
      /** Terminal client: the App instance. */
      app?: unknown;
      /** Terminal client: select a place, person or device as if clicked. */
      select?: (kind: "place" | "npc" | "node", id: string) => void;
      /** Street client: stand at a world position facing a point; returns the place. */
      goTo?: (x: number, z: number, lookAtX?: number, lookAtZ?: number) => string | undefined;
      /** Street client: aim at somebody outdoors; returns their name. */
      aimAtSomebody?: () => string | null;
      /** Street client: the public rooms you can walk into, and where their doors are. */
      rooms?: () => Array<{ name: string; approach: [number, number]; inside: [number, number]; placeIds: string[] }>;
      /** Street client: renderer counters and overlay counts, for the smoke test. */
      stats?: () => { triangles: number; calls: number; cards: number; profiled: number; optical: number; at: [number, number] };
    };
  }
}

export {};
