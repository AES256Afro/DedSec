/**
 * The sky, and the hour it is.
 *
 * The simulation has had a clock since the first commit — routines, shifts,
 * lunch orders and ambulance ETAs are all expressed in world-minutes — and
 * until now the renderer ignored it completely and drew a permanent night. That
 * was a waste of the best free content in the project: the same street at 08:00
 * and at 23:00 is two different places, and the game already knows which one it
 * is.
 *
 * So everything visual that could plausibly depend on the hour does:
 *
 *   · the sun's elevation and bearing, which is what actually makes a street
 *     read as morning rather than afternoon;
 *   · the sky gradient, the fog, and the colour of the light;
 *   · whether the windows are lit, which is the difference between a building
 *     and a silhouette.
 *
 * The values are keyframes on a normalised day and everything between them is
 * interpolated, so dawn arrives over about ninety minutes rather than snapping.
 */

import * as THREE from "three";

import { minuteOfDay } from "../../src/core/time.js";

/** How far out the sky dome sits. Inside the camera's far plane, comfortably. */
const DOME_RADIUS = 3200;

export interface SkyState {
  /** 0 = pitch dark, 1 = full daylight. Drives anything that is not a colour. */
  daylight: number;
  /** 0 = windows dark, 1 = every lit window on. */
  windowGlow: number;
  fog: THREE.Color;
}

interface Keyframe {
  /** Fraction of the day, 0 = midnight. */
  at: number;
  skyTop: number;
  skyBottom: number;
  fog: number;
  sun: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  /** How lit the windows read. Dark by day, full after sunset. */
  glow: number;
}

/**
 * A day. Ordered, wrapping, and deliberately not symmetric — evening light is
 * warmer and lasts longer than morning light, which is most of why dusk reads
 * as dusk rather than as dawn played backwards.
 */
const DAY: Keyframe[] = [
  {
    at: 0.0, // midnight
    skyTop: 0x05070d, skyBottom: 0x0d141f, fog: 0x0c1320,
    sun: 0x8fa8d0, sunIntensity: 0.18,
    hemiSky: 0x27364f, hemiGround: 0x11141a, hemiIntensity: 0.5,
    glow: 1,
  },
  {
    at: 0.21, // 05:00 — the first grey
    skyTop: 0x0b1526, skyBottom: 0x22304a, fog: 0x1d2940,
    sun: 0x9fb0cc, sunIntensity: 0.22,
    hemiSky: 0x35486a, hemiGround: 0x15191f, hemiIntensity: 0.7,
    glow: 0.95,
  },
  {
    at: 0.27, // 06:30 — sunrise
    skyTop: 0x2a4a76, skyBottom: 0xe89a5c, fog: 0xc98f68,
    sun: 0xffb877, sunIntensity: 1.5,
    hemiSky: 0x7b9ac4, hemiGround: 0x3a3129, hemiIntensity: 1.1,
    glow: 0.55,
  },
  {
    at: 0.36, // 08:40 — proper morning
    skyTop: 0x3f82c8, skyBottom: 0xb8d5ee, fog: 0xb3cde4,
    sun: 0xfff0d6, sunIntensity: 2.5,
    hemiSky: 0x9dc4e8, hemiGround: 0x6b6560, hemiIntensity: 1.5,
    glow: 0.06,
  },
  {
    at: 0.5, // noon
    skyTop: 0x2f76c4, skyBottom: 0xc3dcf0, fog: 0xc0d8ec,
    sun: 0xfff8ec, sunIntensity: 3,
    hemiSky: 0xaed2f0, hemiGround: 0x7b756c, hemiIntensity: 1.7,
    glow: 0,
  },
  {
    at: 0.68, // 16:20 — the light goes gold
    skyTop: 0x3a7cbe, skyBottom: 0xd8d2c0, fog: 0xcfc7b2,
    sun: 0xffe6b4, sunIntensity: 2.4,
    hemiSky: 0xa8c6e2, hemiGround: 0x7a6f60, hemiIntensity: 1.4,
    glow: 0.12,
  },
  {
    at: 0.78, // 18:45 — sunset
    skyTop: 0x2c4e86, skyBottom: 0xf08a4c, fog: 0xcf8459,
    sun: 0xff9c52, sunIntensity: 1.5,
    hemiSky: 0x74809e, hemiGround: 0x3f3229, hemiIntensity: 1,
    glow: 0.6,
  },
  {
    at: 0.85, // 20:20 — the blue hour, and the best the city looks
    skyTop: 0x0d1a33, skyBottom: 0x2c3f63, fog: 0x243450,
    sun: 0x7f93bd, sunIntensity: 0.4,
    hemiSky: 0x3a4f76, hemiGround: 0x171a20, hemiIntensity: 0.7,
    glow: 1,
  },
  {
    at: 1.0, // wraps to midnight
    skyTop: 0x05070d, skyBottom: 0x0d141f, fog: 0x0c1320,
    sun: 0x8fa8d0, sunIntensity: 0.18,
    hemiSky: 0x27364f, hemiGround: 0x11141a, hemiIntensity: 0.5,
    glow: 1,
  },
];

const SKY_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  uniform vec3 topColor;
  uniform vec3 bottomColor;
  varying vec3 vWorld;
  void main() {
    // Height above the horizon, eased so the gradient sits low in the sky the
    // way a real one does rather than splitting the dome in half.
    float h = normalize(vWorld).y;
    gl_FragColor = vec4(mix(bottomColor, topColor, pow(max(h, 0.0), 0.55)), 1.0);
  }
`;

export class Sky {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private dome: THREE.Mesh;
  private uniforms: { topColor: { value: THREE.Color }; bottomColor: { value: THREE.Color } };
  private fog: THREE.FogExp2;
  private state: SkyState = { daylight: 1, windowGlow: 0, fog: new THREE.Color() };
  private scratch = new THREE.Color();

  constructor(private readonly scene: THREE.Scene) {
    this.uniforms = {
      topColor: { value: new THREE.Color(0x2f76c4) },
      bottomColor: { value: new THREE.Color(0xc3dcf0) },
    };
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(DOME_RADIUS, 24, 16),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    // The dome is scenery at infinity: never cull it, never let it occlude, and
    // never let a raycast for a person find it first.
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1;
    this.dome.raycast = () => {};
    scene.add(this.dome);

    this.sun = new THREE.DirectionalLight(0xfff8ec, 3);
    scene.add(this.sun);
    this.sun.target.position.set(0, 0, 0);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xaed2f0, 0x7b756c, 1.7);
    scene.add(this.hemi);

    // Fog is thinner by day than by night — you can see across a city at noon
    // and you cannot at two in the morning.
    this.fog = new THREE.FogExp2(0xc0d8ec, 0.0007);
    scene.fog = this.fog;
  }

  /** Keep the dome centred on the camera so its horizon never slides. */
  follow(camera: THREE.Camera): void {
    this.dome.position.copy(camera.position);
  }

  current(): SkyState {
    return this.state;
  }

  update(worldMinutes: number): SkyState {
    const t = minuteOfDay(worldMinutes) / 1440;
    const [a, b, mix] = this.bracket(t);

    this.uniforms.topColor.value.set(a.skyTop).lerp(this.scratch.set(b.skyTop), mix);
    this.uniforms.bottomColor.value.set(a.skyBottom).lerp(this.scratch.set(b.skyBottom), mix);

    this.fog.color.set(a.fog).lerp(this.scratch.set(b.fog), mix);
    // Dense at night, thin at noon: the far side of the city should be visible
    // in daylight and swallowed after dark.
    const glow = a.glow + (b.glow - a.glow) * mix;
    this.fog.density = 0.0006 + glow * 0.0009;
    this.scene.background = this.fog.color;

    this.sun.color.set(a.sun).lerp(this.scratch.set(b.sun), mix);
    this.sun.intensity = a.sunIntensity + (b.sunIntensity - a.sunIntensity) * mix;

    this.hemi.color.set(a.hemiSky).lerp(this.scratch.set(b.hemiSky), mix);
    this.hemi.groundColor.set(a.hemiGround).lerp(this.scratch.set(b.hemiGround), mix);
    this.hemi.intensity = a.hemiIntensity + (b.hemiIntensity - a.hemiIntensity) * mix;

    // Sun rises in the east and sets in the west, peaking at noon. Below the
    // horizon it keeps going and simply stops mattering, which is close enough
    // to a moon that nobody will ask.
    const angle = (t - 0.25) * Math.PI * 2;
    this.sun.position.set(Math.cos(angle) * 900, Math.max(-200, Math.sin(angle) * 900), -320);

    this.state.daylight = Math.max(0, Math.min(1, 1 - glow));
    this.state.windowGlow = glow;
    this.state.fog.copy(this.fog.color);
    return this.state;
  }

  /** The two keyframes `t` falls between, and how far between them it is. */
  private bracket(t: number): [Keyframe, Keyframe, number] {
    for (let i = 0; i < DAY.length - 1; i++) {
      const a = DAY[i]!;
      const b = DAY[i + 1]!;
      if (t >= a.at && t <= b.at) {
        const span = b.at - a.at;
        return [a, b, span <= 0 ? 0 : (t - a.at) / span];
      }
    }
    return [DAY[0]!, DAY[0]!, 0];
  }
}
