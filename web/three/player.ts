/**
 * Walking.
 *
 * The simulation moves people between graph nodes; the player does not. They
 * move continuously, in metres, and every frame we ask which outdoor place they
 * are nearest and hand that answer back to the sim. Everything the sim decides
 * from position — what you can see, what is in radio range, who is standing next
 * to you — therefore keeps working untouched, and the 3D layer stays a *view*
 * with a controller attached rather than a second world model.
 *
 * The one rule this imposes on the city: buildings are solid. You are outside,
 * looking at a street. That is the whole game the casual loop wants, and it is
 * why collision here is four axis-aligned boxes and no more.
 */

import * as THREE from "three";

import type { GameState } from "../../src/sim/state.js";
import { nearestOutdoorPlace } from "./world.js";

const EYE_HEIGHT = 1.68;
/** Shoulder width, near enough. Keeps you off the glass. */
const BODY_RADIUS = 0.9;
const WALK_SPEED = 5.2;
const RUN_SPEED = 9.4;
/** Metres of drift before it is worth re-asking the sim where we are. */
const RESYNC_DISTANCE = 4;
const LOOK_SENSITIVITY = 0.0021;
/** Just short of straight up/down, so the camera can never invert. */
const MAX_PITCH = Math.PI / 2 - 0.05;

export class PlayerController {
  readonly camera: THREE.PerspectiveCamera;
  /** Metres per second, before the run modifier. */
  speed = WALK_SPEED;
  locked = false;

  private yaw = 0;
  private pitch = 0;
  private keys = new Set<string>();
  private colliders: THREE.Box3[] = [];
  private bounds = new THREE.Box3();
  private lastSync = new THREE.Vector3(Infinity, 0, Infinity);
  private forward = new THREE.Vector3();
  private right = new THREE.Vector3();
  private step = new THREE.Vector3();
  private probe = new THREE.Box3();

  constructor(
    private readonly state: GameState,
    private readonly canvas: HTMLElement,
  ) {
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, 4000);
    this.camera.position.y = EYE_HEIGHT;
    this.wire();
  }

  /** Colliders and the walkable envelope, both from the built city. */
  setWorld(colliders: THREE.Box3[], bounds: THREE.Box3): void {
    this.colliders = colliders.map((box) =>
      // Inflate once here rather than testing a radius every frame.
      box.clone().expandByVector(new THREE.Vector3(BODY_RADIUS, 0, BODY_RADIUS)),
    );
    this.bounds = bounds;
  }

  /** Drop the player onto a place, facing a point. */
  spawnAt(x: number, z: number, lookAtX = 0, lookAtZ = 0): void {
    this.camera.position.set(x, EYE_HEIGHT, z);
    // Forward is (-sin yaw, 0, -cos yaw) — the same vector `update` walks
    // along — so facing a target means solving that for yaw, and the extra
    // half-turn a first pass added here pointed the camera at the one part of
    // the map with no city in it.
    this.yaw = Math.atan2(x - lookAtX, z - lookAtZ);
    this.applyLook();
    this.syncToSim(true);
  }

  /* ----------------------------------------------------------------- input */

  private wire(): void {
    this.canvas.addEventListener("click", () => {
      if (!this.locked) this.canvas.requestPointerLock();
    });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.canvas;
      // Keys held when the pointer unlocks would otherwise stick down and walk
      // the player into a wall while they read a panel.
      if (!this.locked) this.keys.clear();
    });
    document.addEventListener("mousemove", (event) => {
      if (!this.locked) return;
      this.yaw -= event.movementX * LOOK_SENSITIVITY;
      this.pitch = Math.max(
        -MAX_PITCH,
        Math.min(MAX_PITCH, this.pitch - event.movementY * LOOK_SENSITIVITY),
      );
      this.applyLook();
    });
    window.addEventListener("keydown", (event) => {
      if (event.target instanceof HTMLInputElement) return;
      this.keys.add(event.code);
      // Space scrolls the page and jumps nowhere; this game has no verticality.
      if (event.code === "Space") event.preventDefault();
    });
    window.addEventListener("keyup", (event) => this.keys.delete(event.code));
    window.addEventListener("blur", () => this.keys.clear());
  }

  private applyLook(): void {
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
  }

  /* ------------------------------------------------------------- movement */

  update(delta: number): void {
    const forwardAxis =
      (this.keys.has("KeyW") || this.keys.has("ArrowUp") ? 1 : 0) -
      (this.keys.has("KeyS") || this.keys.has("ArrowDown") ? 1 : 0);
    const strafeAxis =
      (this.keys.has("KeyD") || this.keys.has("ArrowRight") ? 1 : 0) -
      (this.keys.has("KeyA") || this.keys.has("ArrowLeft") ? 1 : 0);

    if (forwardAxis !== 0 || strafeAxis !== 0) {
      const running = this.keys.has("ShiftLeft") || this.keys.has("ShiftRight");
      const speed = (running ? RUN_SPEED : WALK_SPEED) * delta;

      // Movement is flat: looking at the sky should not slow you down.
      this.forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      this.step
        .copy(this.forward)
        .multiplyScalar(forwardAxis)
        .addScaledVector(this.right, strafeAxis)
        .normalize()
        .multiplyScalar(speed);

      // Resolve one axis at a time so walking into a facade at an angle slides
      // along it instead of stopping dead — the difference between a city you
      // can stroll through and one that keeps catching you.
      this.tryMove(this.step.x, 0);
      this.tryMove(0, this.step.z);
    }

    this.syncToSim(false);
  }

  private tryMove(dx: number, dz: number): void {
    if (dx === 0 && dz === 0) return;
    const position = this.camera.position;
    const x = position.x + dx;
    const z = position.z + dz;

    if (x < this.bounds.min.x || x > this.bounds.max.x) return;
    if (z < this.bounds.min.z || z > this.bounds.max.z) return;

    this.probe.min.set(x, 0, z);
    this.probe.max.set(x, 1, z);
    for (const box of this.colliders) {
      if (box.intersectsBox(this.probe)) return;
    }

    position.x = x;
    position.z = z;
  }

  /**
   * Hand our continuous position back to the discrete world.
   *
   * Snapping to the nearest outdoor place is the entire bridge. It clears any
   * pending walk order, because a player with hands on the keyboard has just
   * overruled whatever the pathfinder was doing.
   */
  private syncToSim(force: boolean): void {
    const position = this.camera.position;
    if (!force && this.lastSync.distanceToSquared(position) < RESYNC_DISTANCE ** 2) return;
    this.lastSync.copy(position);

    const place = nearestOutdoorPlace(this.state, position.x, position.z);
    if (!place || place.id === this.state.player.placeId) return;
    this.state.player.placeId = place.id;
    this.state.player.drone.placeId = place.id;
    this.state.player.path = [];
    delete this.state.player.destinationId;
  }
}
