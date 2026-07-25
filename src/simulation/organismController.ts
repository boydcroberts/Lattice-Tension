import { JellyDynamics, type Vec3Tuple } from "./jellyDynamics";

export type Vec2Tuple = [number, number];

export type OrganismInput = {
  contact: Vec3Tuple | null;
  displacement: Vec2Tuple;
  velocity: Vec2Tuple;
  active: boolean;
  contactCount: number;
  squeeze: number;
  twist: number;
};

export type SurfaceWaveSample = Readonly<{
  origin: Vec3Tuple;
  age: number;
  strength: number;
}>;

export type OrganismSnapshot = Readonly<{
  phase: number;
  strain: number;
  strainVelocity: number;
  /** Fast surface-tension mode, summed into axial strain by the renderer. */
  skin: number;
  /** Low-passed deformation rate driving the non-Newtonian response. */
  shearRate: number;
  axis: Vec3Tuple;
  bend: Vec3Tuple;
  slosh: Vec3Tuple;
  spin: Vec2Tuple;
  torsion: number;
  contactPressure: number;
  contactOrigin: Vec3Tuple;
  secondaryContactOrigin: Vec3Tuple;
  secondaryContactPressure: number;
  contactCount: number;
  squeeze: number;
  /** All ring-buffer slots, live or not. Stable length; consumers filter by age. */
  surfaceWaves: readonly SurfaceWaveSample[];
  /** The subset of `surfaceWaves` still contributing, compacted to the front.
   * Only the first `liveWaveCount` entries are meaningful. */
  liveWaves: readonly SurfaceWaveSample[];
  liveWaveCount: number;
  energy: number;
  resonance: number;
  interactionId: number;
  dragging: boolean;
  pointer: Vec2Tuple;
  position: Vec3Tuple;
  rotation: Vec3Tuple;
  modelScale: number;
}>;

export const ORGANISM_RADIUS = 0.215;
export const ORGANISM_MODEL_SCALE = 0.72;
export const SURFACE_WAVE_LIFETIME = 4.5;

const FIXED_STEP = 1 / 120;
const MAX_FRAME_TIME = 1 / 15;
/** Ring-buffer depth for touch memory. Doubled from 4 once the renderer stopped
 * paying for dead slots — see `liveWaves` below. */
const WAVE_COUNT = 8;
const MAX_CONTACTS = 5;
/** Below this a wave contributes nothing visible and is dropped from the upload. */
const LIVE_WAVE_EPSILON = 0.004;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const wrapAngle = (value: number) =>
  Math.atan2(Math.sin(value), Math.cos(value));

const length2 = (value: Vec2Tuple) => Math.hypot(value[0], value[1]);

const length3 = (value: Vec3Tuple) =>
  Math.hypot(value[0], value[1], value[2]);

const normalize3 = (value: Vec3Tuple): Vec3Tuple => {
  const magnitude = Math.max(length3(value), 1e-6);
  return [value[0] / magnitude, value[1] / magnitude, value[2] / magnitude];
};

const copy3 = (target: Vec3Tuple, source: Vec3Tuple) => {
  target[0] = source[0];
  target[1] = source[1];
  target[2] = source[2];
};

const copy2 = (target: Vec2Tuple, source: Vec2Tuple) => {
  target[0] = source[0];
  target[1] = source[1];
};

type MutableWave = {
  origin: Vec3Tuple;
  age: number;
  strength: number;
};

type Release = {
  velocity: Vec2Tuple;
  strength: number;
  contact: Vec3Tuple;
};

type ActiveContact = {
  start: Vec3Tuple;
  normal: Vec3Tuple;
  displacement: Vec2Tuple;
  velocity: Vec2Tuple;
};

/**
 * The singular physical authority for Aesther. It is intentionally imperative:
 * R3F, the material, the ambient field, and audio read one stable snapshot while
 * React only owns low-frequency application state.
 */
export class OrganismController {
  readonly input: OrganismInput = {
    contact: null,
    displacement: [0, 0],
    velocity: [0, 0],
    active: false,
    contactCount: 0,
    squeeze: 0,
    twist: 0,
  };

  readonly snapshot: OrganismSnapshot;

  private readonly dynamics = new JellyDynamics();
  private readonly waves: MutableWave[] = Array.from({ length: WAVE_COUNT }, () => ({
    origin: [0, 0, 1],
    age: SURFACE_WAVE_LIFETIME,
    strength: 0,
  }));
  /** Preallocated compaction target — reused every step, never reallocated.
   * No sorting: `waves` and this share a length, so the live set can never
   * exceed capacity and there is nothing to prioritise away. */
  private readonly liveWaves: MutableWave[] = Array.from({ length: WAVE_COUNT }, () => ({
    origin: [0, 0, 1],
    age: SURFACE_WAVE_LIFETIME,
    strength: 0,
  }));
  private accumulator = 0;
  private liveWaveCount = 0;
  private waveCursor = 0;
  private time = 0;
  private lastWaveAt = -Infinity;
  private resonance = 0;
  private interactionId = 0;
  private readonly contacts = new Map<number, ActiveContact>();
  private readonly pendingTaps: Vec3Tuple[] = [];
  private readonly pendingReleases: Release[] = [];
  private deformationAxis: Vec3Tuple = [0, 1, 0];
  private modelScale = ORGANISM_MODEL_SCALE;

  constructor() {
    const initialContact: Vec3Tuple = [0, 0, 1];
    const initialPosition: Vec3Tuple = [0.035, 0.005, 0];
    const initialRotation: Vec3Tuple = [0, 0, 0];
    this.snapshot = {
      phase: 0,
      strain: 0,
      strainVelocity: 0,
      skin: 0,
      shearRate: 0,
      axis: [0, 1, 0],
      bend: [0, 0, 0],
      slosh: [0, 0, 0],
      spin: [0, 0],
      torsion: 0,
      contactPressure: 0,
      contactOrigin: initialContact,
      secondaryContactOrigin: [...initialContact],
      secondaryContactPressure: 0,
      contactCount: 0,
      squeeze: 0,
      surfaceWaves: this.waves,
      liveWaves: this.liveWaves,
      liveWaveCount: 0,
      energy: 0,
      resonance: 0,
      interactionId: 0,
      dragging: false,
      pointer: [0, 0],
      position: initialPosition,
      rotation: initialRotation,
      modelScale: ORGANISM_MODEL_SCALE,
    };
  }

  reset() {
    this.dynamics.reset();
    this.input.active = false;
    this.input.contact = null;
    this.input.contactCount = 0;
    this.input.squeeze = 0;
    this.input.twist = 0;
    copy2(this.input.displacement, [0, 0]);
    copy2(this.input.velocity, [0, 0]);
    this.accumulator = 0;
    this.time = 0;
    this.lastWaveAt = -Infinity;
    this.resonance = 0;
    this.interactionId = 0;
    this.contacts.clear();
    this.pendingTaps.length = 0;
    this.pendingReleases.length = 0;
    copy3(this.deformationAxis, [0, 1, 0]);
    this.waveCursor = 0;
    this.liveWaveCount = 0;
    [...this.waves, ...this.liveWaves].forEach((wave) => {
      copy3(wave.origin, [0, 0, 1]);
      wave.age = SURFACE_WAVE_LIFETIME;
      wave.strength = 0;
    });
    this.writeSnapshot(this.dynamics.state, [0, 0, 1], 0, 0);
  }

  beginContact(contact: Vec3Tuple, pointerId = 0) {
    if (!isSurfaceContact(contact)) return false;
    if (!this.contacts.has(pointerId) && this.contacts.size >= MAX_CONTACTS) return false;
    const normal = normalize3(contact);
    this.contacts.set(pointerId, {
      start: [...normal],
      normal: [...normal],
      displacement: [0, 0],
      velocity: [0, 0],
    });
    this.refreshContactAggregate();
    this.dynamics.applyCompression(normal, 0.17 + Math.min(this.contacts.size, 3) * 0.05);
    this.resonance = clamp(
      this.resonance + 0.045 + Math.min(this.contacts.size, 3) * 0.018,
      0,
      1.5,
    );
    this.interactionId += 1;
    return true;
  }

  moveContact(
    contact: Vec3Tuple,
    displacement: Vec2Tuple,
    velocity: Vec2Tuple,
    pointerId = 0,
  ) {
    const activeContact = this.contacts.get(pointerId);
    if (!activeContact || !isSurfaceContact(contact)) return false;
    const normal = normalize3(contact);
    copy3(activeContact.normal, normal);
    copy2(activeContact.displacement, [
      clamp(displacement[0], -0.72, 0.72),
      clamp(displacement[1], -0.72, 0.72),
    ]);
    copy2(activeContact.velocity, [
      clamp(velocity[0], -4.8, 4.8),
      clamp(velocity[1], -4.8, 4.8),
    ]);
    this.refreshContactAggregate();
    return true;
  }

  endContact(velocity: Vec2Tuple, travel: number, pointerId = 0) {
    const activeContact = this.contacts.get(pointerId);
    if (!activeContact) return;
    const contact: Vec3Tuple = [...activeContact.normal];
    const releaseVelocity: Vec2Tuple = [
      clamp(velocity[0], -5.2, 5.2),
      clamp(velocity[1], -5.2, 5.2),
    ];
    const motion = Math.max(length2(releaseVelocity) * 0.18, travel * 1.75);

    this.contacts.delete(pointerId);
    this.refreshContactAggregate();
    const remainingContactScale = this.contacts.size > 0 ? 0.68 : 1;

    if (travel < 0.045 && length2(releaseVelocity) < 0.36) {
      this.pendingTaps.push(contact);
    } else {
      const strength = clamp((0.18 + motion) * remainingContactScale, 0.16, 1.35);
      this.pendingReleases.push({
        velocity: releaseVelocity,
        strength,
        contact,
      });
    }
  }

  cancelContact(pointerId?: number) {
    if (pointerId === undefined) {
      this.contacts.clear();
    } else {
      this.contacts.delete(pointerId);
    }
    this.refreshContactAggregate();
  }

  private refreshContactAggregate() {
    const contacts = Array.from(this.contacts.values());
    this.input.contactCount = contacts.length;
    this.input.active = contacts.length > 0;

    if (contacts.length === 0) {
      this.input.contact = null;
      this.input.squeeze = 0;
      this.input.twist = 0;
      copy2(this.input.displacement, [0, 0]);
      copy2(this.input.velocity, [0, 0]);
      return;
    }

    const currentCenter: Vec2Tuple = [0, 0];
    const startCenter: Vec2Tuple = [0, 0];
    const aggregateNormal: Vec3Tuple = [0, 0, 0];
    const aggregateDisplacement: Vec2Tuple = [0, 0];
    const aggregateVelocity: Vec2Tuple = [0, 0];

    contacts.forEach((contact) => {
      aggregateNormal[0] += contact.normal[0];
      aggregateNormal[1] += contact.normal[1];
      aggregateNormal[2] += contact.normal[2];
      currentCenter[0] += contact.normal[0];
      currentCenter[1] += contact.normal[1];
      startCenter[0] += contact.start[0];
      startCenter[1] += contact.start[1];
      aggregateDisplacement[0] += contact.displacement[0];
      aggregateDisplacement[1] += contact.displacement[1];
      aggregateVelocity[0] += contact.velocity[0];
      aggregateVelocity[1] += contact.velocity[1];
    });

    const inverseCount = 1 / contacts.length;
    currentCenter[0] *= inverseCount;
    currentCenter[1] *= inverseCount;
    startCenter[0] *= inverseCount;
    startCenter[1] *= inverseCount;
    copy2(this.input.displacement, [
      aggregateDisplacement[0] * inverseCount,
      aggregateDisplacement[1] * inverseCount,
    ]);
    copy2(this.input.velocity, [
      aggregateVelocity[0] * inverseCount,
      aggregateVelocity[1] * inverseCount,
    ]);
    this.input.contact = normalize3(aggregateNormal);

    if (contacts.length === 1) {
      this.input.squeeze = 0;
      this.input.twist = 0;
      copy3(this.deformationAxis, contacts[0]!.normal);
      this.dynamics.setAxis(this.deformationAxis);
      return;
    }

    let startRadiusSquared = 0;
    let currentRadiusSquared = 0;
    let rotationCross = 0;
    let rotationDot = 0;
    let farthestDistanceSquared = -1;
    let farthestDelta: Vec2Tuple = [0, 0];

    contacts.forEach((contact, index) => {
      const startX = contact.start[0] - startCenter[0];
      const startY = contact.start[1] - startCenter[1];
      const currentX = contact.normal[0] - currentCenter[0];
      const currentY = contact.normal[1] - currentCenter[1];
      startRadiusSquared += startX * startX + startY * startY;
      currentRadiusSquared += currentX * currentX + currentY * currentY;
      rotationCross += startX * currentY - startY * currentX;
      rotationDot += startX * currentX + startY * currentY;

      for (let otherIndex = index + 1; otherIndex < contacts.length; otherIndex += 1) {
        const other = contacts[otherIndex]!;
        const dx = other.normal[0] - contact.normal[0];
        const dy = other.normal[1] - contact.normal[1];
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared > farthestDistanceSquared) {
          farthestDistanceSquared = distanceSquared;
          farthestDelta = [dx, dy];
        }
      }
    });

    const startSpread = Math.sqrt(startRadiusSquared * inverseCount);
    const currentSpread = Math.sqrt(currentRadiusSquared * inverseCount);
    this.input.squeeze = clamp((startSpread - currentSpread) * 2.4, -0.48, 0.82);
    this.input.twist = clamp(
      wrapAngle(Math.atan2(rotationCross, rotationDot)),
      -1.1,
      1.1,
    );

    const pinchAxis = normalize3([
      farthestDelta[0],
      farthestDelta[1],
      Math.max(0.12, Math.abs(this.input.contact[2]) * 0.18),
    ]);
    copy3(this.deformationAxis, pinchAxis);
    this.dynamics.setAxis(this.deformationAxis);
  }

  pulseFromKeyboard(direction: Vec2Tuple = [0, 0]) {
    const x = clamp(direction[0], -1, 1);
    const y = clamp(direction[1], -1, 1);
    const contact = normalize3([x * 0.52, y * 0.52, 1]);
    const strength = length2(direction) > 0 ? 0.54 : 0.34;
    this.pendingReleases.push({
      velocity: [x * 1.35, y * 1.35],
      strength,
      contact,
    });
  }

  setPresentationScale(scale: number) {
    this.modelScale = clamp(scale, 0.42, ORGANISM_MODEL_SCALE);
    (this.snapshot as { modelScale: number }).modelScale = this.modelScale;
  }

  advance(frameTime: number, reducedMotion: boolean) {
    this.accumulator += Math.min(Math.max(frameTime, 0), MAX_FRAME_TIME);
    while (this.accumulator >= FIXED_STEP) {
      this.step(FIXED_STEP, reducedMotion ? 0.18 : 1);
      this.accumulator -= FIXED_STEP;
    }
    return this.snapshot;
  }

  private step(dt: number, motionScale: number) {
    this.time += dt;
    this.resolveQueuedImpulses();

    const contact = this.input.contact ?? this.snapshot.contactOrigin;
    const dragMagnitude = length2(this.input.displacement);
    const activeVelocity = length2(this.input.velocity);
    const contactStrength = this.input.active
      ? clamp(
          0.32 +
            this.input.contactCount * 0.12 +
            dragMagnitude * 0.38 +
            activeVelocity * 0.03 +
            Math.max(0, this.input.squeeze) * 0.34,
          0,
          1,
        )
      : 0;

    if (this.input.active && activeVelocity > 0.55 && this.time - this.lastWaveAt > 0.19) {
      this.spawnWave(contact, clamp(0.22 + activeVelocity * 0.09, 0.22, 0.68));
    }

    const idleTarget =
      (Math.sin(this.time * 0.44) * 0.016 + Math.sin(this.time * 0.19 + 1.4) * 0.009) *
      motionScale;
    const state = this.dynamics.advance(dt, {
      dragX: this.input.displacement[0],
      dragY: this.input.displacement[1],
      dragging: this.input.active,
      idleTarget,
      motionScale,
      contactStrength,
      squeeze: this.input.squeeze,
      twist: this.input.twist,
      dragRate: activeVelocity,
    });

    let waveEnergy = 0;
    let liveCount = 0;
    this.waves.forEach((wave) => {
      wave.age = Math.min(SURFACE_WAVE_LIFETIME, wave.age + dt);
      const life = Math.max(0, 1 - wave.age / SURFACE_WAVE_LIFETIME);
      wave.strength *= Math.exp(-dt * 0.26);
      const contribution = wave.strength * life;
      waveEnergy += contribution;

      // Compact the still-contributing waves to the front so the shader can
      // loop over exactly `liveWaveCount` slots instead of evaluating every
      // slot unconditionally. At rest this is 0, so the ripple sum costs
      // nothing at all — the state the orb spends most of its time in.
      if (contribution > LIVE_WAVE_EPSILON) {
        const target = this.liveWaves[liveCount]!;
        copy3(target.origin, wave.origin);
        target.age = wave.age;
        target.strength = wave.strength;
        liveCount += 1;
      }
    });
    this.liveWaveCount = liveCount;

    const interactionEnergy =
      state.kineticEnergy +
      waveEnergy * 0.33 +
      contactStrength * 0.12 +
      Math.abs(this.input.squeeze) * 0.14 +
      Math.abs(this.input.twist) * 0.06;
    this.resonance += (interactionEnergy * 0.23 - this.resonance * 0.62) * dt;
    this.resonance = clamp(this.resonance, 0, 1.5);
    this.writeSnapshot(state, contact, motionScale, interactionEnergy);
  }

  private resolveQueuedImpulses() {
    if (this.pendingTaps.length > 0) {
      const taps = this.pendingTaps.splice(0, MAX_CONTACTS);
      const sharedScale = 1 / Math.sqrt(taps.length);
      taps.forEach((contact) => {
        this.dynamics.applyCompression(contact, 0.52 * sharedScale);
        this.dynamics.applyImpulse(contact, 0.18 * sharedScale);
        this.spawnWave(contact, 0.38 + 0.08 * sharedScale);
      });
      this.resonance = clamp(
        this.resonance + 0.17 + taps.length * 0.045,
        0,
        1.5,
      );
      this.interactionId += taps.length;
    }

    if (this.pendingReleases.length > 0) {
      const releases = this.pendingReleases.splice(0, MAX_CONTACTS);
      let velocityX = 0;
      let velocityY = 0;
      let weight = 0;
      let strengthSquared = 0;
      const releaseAxis: Vec3Tuple = [0, 0, 0];

      releases.forEach(({ velocity, strength, contact }) => {
        velocityX += velocity[0] * strength;
        velocityY += velocity[1] * strength;
        weight += strength;
        strengthSquared += strength * strength;
        releaseAxis[0] += contact[0] * strength;
        releaseAxis[1] += contact[1] * strength;
        releaseAxis[2] += contact[2] * strength;
        this.spawnWave(contact, 0.34 + strength * 0.42);
      });

      const combinedStrength = clamp(Math.sqrt(strengthSquared), 0.16, 1.55);
      const inverseWeight = 1 / Math.max(weight, 0.001);
      this.dynamics.applyFlick(
        velocityX * inverseWeight,
        velocityY * inverseWeight,
        combinedStrength,
      );
      this.dynamics.applyImpulse(
        normalize3(releaseAxis),
        0.16 + combinedStrength * 0.34,
      );
      this.resonance = clamp(
        this.resonance + 0.16 + combinedStrength * 0.17,
        0,
        1.5,
      );
      this.interactionId += releases.length;
    }
  }

  private spawnWave(origin: Vec3Tuple, strength: number) {
    const wave = this.waves[this.waveCursor]!;
    copy3(wave.origin, normalize3(origin));
    wave.age = 0;
    wave.strength = clamp(strength, 0.12, 1);
    this.waveCursor = (this.waveCursor + 1) % this.waves.length;
    this.lastWaveAt = this.time;
  }

  private writeSnapshot(
    state: ReturnType<JellyDynamics["advance"]>,
    contact: Vec3Tuple,
    motionScale: number,
    interactionEnergy: number,
  ) {
    const snapshot = this.snapshot as {
      phase: number;
      strain: number;
      strainVelocity: number;
      skin: number;
      shearRate: number;
      axis: Vec3Tuple;
      bend: Vec3Tuple;
      slosh: Vec3Tuple;
      spin: Vec2Tuple;
      torsion: number;
      contactPressure: number;
      contactOrigin: Vec3Tuple;
      secondaryContactOrigin: Vec3Tuple;
      secondaryContactPressure: number;
      contactCount: number;
      squeeze: number;
      liveWaveCount: number;
      energy: number;
      resonance: number;
      interactionId: number;
      dragging: boolean;
      pointer: Vec2Tuple;
      position: Vec3Tuple;
      rotation: Vec3Tuple;
      modelScale: number;
    };

    snapshot.phase = this.time;
    snapshot.strain = state.strain;
    snapshot.strainVelocity = state.strainVelocity;
    snapshot.skin = state.skin;
    snapshot.shearRate = state.shearRate;
    copy3(snapshot.axis, state.axis);
    copy3(snapshot.bend, state.bend);
    copy3(snapshot.slosh, state.slosh);
    copy2(snapshot.spin, state.angularOffset);
    snapshot.torsion = state.torsion;
    snapshot.contactPressure = state.contactPressure;
    const activeContacts = Array.from(this.contacts.values());
    copy3(snapshot.contactOrigin, activeContacts[0]?.normal ?? contact);
    copy3(
      snapshot.secondaryContactOrigin,
      activeContacts[1]?.normal ?? activeContacts[0]?.normal ?? contact,
    );
    snapshot.secondaryContactPressure =
      activeContacts.length > 1 ? state.contactPressure * 0.92 : 0;
    snapshot.contactCount = activeContacts.length;
    snapshot.squeeze = this.input.squeeze;
    snapshot.liveWaveCount = this.liveWaveCount;
    snapshot.energy = clamp(interactionEnergy, 0, 1.5);
    snapshot.resonance = this.resonance;
    snapshot.interactionId = this.interactionId;
    snapshot.dragging = this.input.active;
    const pointerContact = this.input.contact ?? contact;
    copy2(snapshot.pointer, [pointerContact[0], pointerContact[1]]);

    const idle = motionScale * 0.5 + 0.5;
    snapshot.position[0] = 0.035 + this.input.displacement[0] * 0.045 + state.slosh[0] * 0.028;
    snapshot.position[1] = 0.005 - this.input.displacement[1] * 0.035 + state.slosh[1] * 0.022;
    snapshot.position[2] = 0;
    snapshot.rotation[0] =
      Math.sin(this.time * 0.11) * 0.075 * idle + state.angularOffset[0] + this.input.displacement[1] * 0.62;
    snapshot.rotation[1] =
      this.time * 0.032 * motionScale + Math.sin(this.time * 0.19) * 0.042 * idle + state.angularOffset[1] + this.input.displacement[0] * 0.72;
    snapshot.rotation[2] =
      Math.cos(this.time * 0.083) * 0.026 * motionScale +
      state.bend[0] * 0.08 +
      state.torsion;
    snapshot.modelScale = this.modelScale;
  }
}

/** Contact proxy guards use this before they pass a point into the solver. */
export function isSurfaceContact(point: Vec3Tuple) {
  const magnitude = length3(point);
  return magnitude > 0.68 && magnitude < 1.35;
}

export const organismController = new OrganismController();
