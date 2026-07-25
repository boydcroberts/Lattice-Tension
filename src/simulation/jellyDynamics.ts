export type Vec3Tuple = [number, number, number];

export type JellyPhysicsConfig = {
  fixedStep: number;
  maxFrameTime: number;
  stiffness: number;
  damping: number;
  dragCompliance: number;
  sloshStiffness: number;
  sloshDamping: number;
  spinDamping: number;
  contactStiffness: number;
  contactDamping: number;
  torsionStiffness: number;
  torsionDamping: number;
  /** How strongly fast deformation stiffens the material (shear thickening). */
  shearThickening: number;
  /** How strongly fast deformation raises viscous damping. */
  viscousGain: number;
  /** First-order lag on the shear-rate estimate, in 1/s. */
  shearRateLag: number;
  /** Hard ceiling on effective damping; explicit integration needs damping*dt < 2. */
  dampingCeiling: number;
  /** Surface-tension restoring stiffness. Much higher than the bulk on purpose. */
  skinStiffness: number;
  skinDamping: number;
  /** How strongly total deformation drives the skin mode. */
  skinCoupling: number;
};

export type JellyDynamicsInput = {
  dragX: number;
  dragY: number;
  dragging: boolean;
  idleTarget: number;
  motionScale: number;
  /** Local pressure is separate from drag distance: a held touch compresses
   * the shell before a pull stretches it. */
  contactStrength?: number;
  /** Positive values pinch inward; negative values pull the contact group apart. */
  squeeze?: number;
  /** Signed in-plane rotation of a multi-contact group. */
  twist?: number;
  /** Pointer speed across the surface. Drives the non-Newtonian response: the
   * material resists fast deformation and flows under slow load. */
  dragRate?: number;
};

export type JellyDynamicsState = {
  /** Logarithmic axial stretch. Perpendicular scale is derived to preserve volume. */
  strain: number;
  strainVelocity: number;
  axis: Vec3Tuple;
  bend: Vec3Tuple;
  slosh: Vec3Tuple;
  angularOffset: [number, number];
  torsion: number;
  torsionVelocity: number;
  contactPressure: number;
  kineticEnergy: number;
  /** Low-passed deformation rate. 0 at rest, rising with fast drags. */
  shearRate: number;
  /** Fast surface-tension mode. Rings ~3x above the bulk band. */
  skin: number;
  skinVelocity: number;
};

const DEFAULT_CONFIG: JellyPhysicsConfig = {
  fixedStep: 1 / 120,
  maxFrameTime: 1 / 15,
  stiffness: 19,
  damping: 4.15,
  dragCompliance: 0.62,
  sloshStiffness: 8.4,
  sloshDamping: 1.95,
  spinDamping: 0.86,
  contactStiffness: 28,
  contactDamping: 7.2,
  torsionStiffness: 14,
  torsionDamping: 4.6,
  shearThickening: 0.42,
  viscousGain: 0.55,
  shearRateLag: 6.5,
  dampingCeiling: 24,
  // sqrt(190) ~= 13.8 rad/s ~= 2.2 Hz, about 3.2x the bulk band (sqrt(19) ~= 4.4),
  // so the skin reads as a distinct fast shimmer rather than more of the same
  // wobble. zeta ~= 0.087 lets it ring 1-2s. skinStiffness*dt^2 = 0.013 at the
  // fixed 1/120 step, well inside explicit-integrator stability.
  skinStiffness: 190,
  skinDamping: 2.4,
  skinCoupling: 0.16,
};

/** Pointer speed above this is treated as maximum shear; keeps the response bounded. */
const MAX_SHEAR_RATE = 5;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const length3 = (value: Vec3Tuple) =>
  Math.hypot(value[0], value[1], value[2]);

const normalize3 = (value: Vec3Tuple): Vec3Tuple => {
  const length = Math.max(1e-6, length3(value));
  return [value[0] / length, value[1] / length, value[2] / length];
};

/**
 * Small modal viscoelastic simulation for the hero orb. It is deliberately not
 * a particle fluid: a handful of coupled modes gives the material convincing
 * weight while keeping the render budget available for the raymarch.
 */
export class JellyDynamics {
  readonly state: JellyDynamicsState = {
    strain: 0,
    strainVelocity: 0,
    axis: [0, 1, 0],
    bend: [0, 0, 0],
    slosh: [0, 0, 0],
    angularOffset: [0, 0],
    torsion: 0,
    torsionVelocity: 0,
    contactPressure: 0,
    kineticEnergy: 0,
    shearRate: 0,
    skin: 0,
    skinVelocity: 0,
  };

  private readonly config: JellyPhysicsConfig;
  private accumulator = 0;
  private bendVelocity: Vec3Tuple = [0, 0, 0];
  private sloshVelocity: Vec3Tuple = [0, 0, 0];
  private angularVelocity: [number, number] = [0, 0];
  private pressureVelocity = 0;
  private phase = 0;

  constructor(config: Partial<JellyPhysicsConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  reset() {
    this.state.strain = 0;
    this.state.strainVelocity = 0;
    this.state.axis[0] = 0;
    this.state.axis[1] = 1;
    this.state.axis[2] = 0;
    this.state.bend.fill(0);
    this.state.slosh.fill(0);
    this.state.angularOffset.fill(0);
    this.state.torsion = 0;
    this.state.torsionVelocity = 0;
    this.state.contactPressure = 0;
    this.state.kineticEnergy = 0;
    this.state.shearRate = 0;
    this.state.skin = 0;
    this.state.skinVelocity = 0;
    this.accumulator = 0;
    this.bendVelocity.fill(0);
    this.sloshVelocity.fill(0);
    this.angularVelocity.fill(0);
    this.pressureVelocity = 0;
    this.phase = 0;
  }

  setAxis(axis: Vec3Tuple) {
    const normalized = normalize3(axis);
    const blend = 0.32;
    this.state.axis = normalize3([
      this.state.axis[0] + (normalized[0] - this.state.axis[0]) * blend,
      this.state.axis[1] + (normalized[1] - this.state.axis[1]) * blend,
      this.state.axis[2] + (normalized[2] - this.state.axis[2]) * blend,
    ]);
  }

  applyImpulse(axis: Vec3Tuple, strength = 1) {
    this.setAxis(axis);
    const amount = clamp(strength, 0, 2.2);
    this.state.strainVelocity += amount * 2.35;
    this.pressureVelocity += amount * 2.8;
    this.sloshVelocity[0] -= this.state.axis[0] * amount * 1.4;
    this.sloshVelocity[1] -= this.state.axis[1] * amount * 1.4;
    this.sloshVelocity[2] -= this.state.axis[2] * amount * 0.8;
  }

  applyCompression(axis: Vec3Tuple, strength = 1) {
    this.setAxis(axis);
    const amount = clamp(strength, 0, 1.4);
    this.state.strainVelocity -= amount * 1.72;
    this.pressureVelocity += amount * 3.35;
    this.sloshVelocity[0] += this.state.axis[0] * amount * 0.72;
    this.sloshVelocity[1] += this.state.axis[1] * amount * 0.72;
    this.sloshVelocity[2] += this.state.axis[2] * amount * 0.52;
  }

  applyFlick(x: number, y: number, strength = 1) {
    const amount = clamp(strength, 0, 1.6);
    this.setAxis([x, -y, 0.42]);
    this.angularVelocity[0] = clamp(
      this.angularVelocity[0] - y * amount * 5.2,
      -3.5,
      3.5,
    );
    this.angularVelocity[1] = clamp(
      this.angularVelocity[1] + x * amount * 6.2,
      -3.5,
      3.5,
    );
    this.state.strainVelocity += Math.hypot(x, y) * amount * 2.8;
    this.sloshVelocity[0] += x * amount * 4.15;
    this.sloshVelocity[1] -= y * amount * 4.15;
    this.bendVelocity[0] += x * amount * 1.08;
    this.bendVelocity[1] -= y * amount * 1.08;
  }

  advance(frameTime: number, input: JellyDynamicsInput) {
    this.accumulator += Math.min(Math.max(frameTime, 0), this.config.maxFrameTime);
    while (this.accumulator >= this.config.fixedStep) {
      this.step(this.config.fixedStep, input);
      this.accumulator -= this.config.fixedStep;
    }
    return this.state;
  }

  private step(dt: number, input: JellyDynamicsInput) {
    this.phase += dt;
    const motion = clamp(input.motionScale, 0, 1);
    const dragMagnitude = Math.hypot(input.dragX, input.dragY);
    const contactStrength = clamp(input.contactStrength ?? 0, 0, 1);
    const squeeze = clamp(input.squeeze ?? 0, -0.48, 0.82);
    const twist = clamp(input.twist ?? 0, -1.1, 1.1);

    // Non-Newtonian response. Real soft matter is not a linear spring: pull it
    // slowly and it flows, yank it and it resists like a solid before releasing.
    // The rate is low-passed with the same exp(-k*dt) form as spinDecay below so
    // the material stays frame-rate independent, and a single jittery pointer
    // sample cannot spike it. shearRate is 0 whenever dragRate is absent, which
    // collapses both terms below to the original constants exactly.
    const rateTarget = clamp(input.dragRate ?? 0, 0, MAX_SHEAR_RATE);
    this.state.shearRate +=
      (rateTarget - this.state.shearRate) *
      (1 - Math.exp(-this.config.shearRateLag * dt));

    const effectiveCompliance =
      this.config.dragCompliance /
      (1 + this.config.shearThickening * this.state.shearRate);
    // Ceiling guards the explicit integrator: it needs damping*dt < 2, and this
    // keeps the worst case an order of magnitude inside that bound.
    const effectiveDamping = Math.min(
      this.config.dampingCeiling,
      this.config.damping * (1 + this.config.viscousGain * this.state.shearRate),
    );

    const strainTarget = clamp(
      input.idleTarget * motion +
        (input.dragging
          ? dragMagnitude * effectiveCompliance -
            contactStrength * 0.1 -
            squeeze * 0.38
          : 0),
      -0.12,
      0.3,
    );

    const strainAcceleration =
      (strainTarget - this.state.strain) * this.config.stiffness -
      this.state.strainVelocity * effectiveDamping;
    this.state.strainVelocity += strainAcceleration * dt;
    this.state.strain += this.state.strainVelocity * dt;
    this.state.strain = clamp(this.state.strain, -0.22, 0.34);

    const idleBend: Vec3Tuple = input.dragging
      ? [0, 0, 0]
      : [
          Math.sin(this.phase * 0.43) * 0.05 * motion,
          Math.cos(this.phase * 0.31 + 0.7) * 0.04 * motion,
          Math.sin(this.phase * 0.23 + 1.4) * 0.026 * motion,
        ];
    const bendTarget: Vec3Tuple = input.dragging
      ? [input.dragX * 0.58, -input.dragY * 0.58, dragMagnitude * 0.1]
      : [
          idleBend[0] + this.state.slosh[0] * 0.12,
          idleBend[1] + this.state.slosh[1] * 0.12,
          idleBend[2] + this.state.slosh[2] * 0.08,
        ];
    const sloshTarget: Vec3Tuple = [
      -input.dragX * 0.3 + Math.sin(this.phase * 0.37) * 0.028 * motion,
      input.dragY * 0.3 + Math.cos(this.phase * 0.29) * 0.024 * motion,
      -this.state.strain * 0.24 +
        squeeze * 0.12 +
        Math.sin(this.phase * 0.21) * 0.018 * motion,
    ];

    for (let index = 0; index < 3; index += 1) {
      const bendAcceleration =
        (bendTarget[index] - this.state.bend[index]) * 13.5 -
        this.bendVelocity[index] * 4.6;
      this.bendVelocity[index] += bendAcceleration * dt;
      this.state.bend[index] += this.bendVelocity[index] * dt;

      const sloshAcceleration =
        (sloshTarget[index] - this.state.slosh[index]) * this.config.sloshStiffness -
        this.sloshVelocity[index] * this.config.sloshDamping;
      this.sloshVelocity[index] += sloshAcceleration * dt;
      this.state.slosh[index] += this.sloshVelocity[index] * dt;
      this.state.slosh[index] = clamp(this.state.slosh[index], -0.42, 0.42);
    }

    const pressureTarget =
      (contactStrength * 0.24 + Math.max(0, squeeze) * 0.38) * motion;
    const pressureAcceleration =
      (pressureTarget - this.state.contactPressure) * this.config.contactStiffness -
      this.pressureVelocity * this.config.contactDamping;
    this.pressureVelocity += pressureAcceleration * dt;
    this.state.contactPressure += this.pressureVelocity * dt;
    this.state.contactPressure = clamp(this.state.contactPressure, 0, 0.42);

    const torsionTarget = input.dragging ? twist * 0.68 * motion : 0;
    const torsionAcceleration =
      (torsionTarget - this.state.torsion) * this.config.torsionStiffness -
      this.state.torsionVelocity * this.config.torsionDamping;
    this.state.torsionVelocity += torsionAcceleration * dt;
    this.state.torsion += this.state.torsionVelocity * dt;
    this.state.torsion = clamp(this.state.torsion, -0.82, 0.82);

    // Surface tension: a fast, lightly-damped mode that pulls the shape back
    // toward a sphere well above the bulk frequency. Every other mode here sits
    // in one low band, which is what made the orb read as a single spring; this
    // adds the second band — a quick silhouette shimmer riding the slow slosh.
    // It is summed into the shader's axial strain (JellyOrb.tsx), so it travels
    // through volumeScaleFromStrain and stays volume-preserving for free.
    const deformation =
      Math.abs(this.state.strain) +
      length3(this.state.bend) * 0.8 +
      Math.abs(this.state.torsion) * 0.4;
    const skinTarget = -deformation * this.config.skinCoupling * motion;
    const skinAcceleration =
      (skinTarget - this.state.skin) * this.config.skinStiffness -
      this.state.skinVelocity * this.config.skinDamping;
    this.state.skinVelocity += skinAcceleration * dt;
    this.state.skin += this.state.skinVelocity * dt;

    const spinDecay = Math.exp(-this.config.spinDamping * dt);
    this.angularVelocity[0] *= spinDecay;
    this.angularVelocity[1] *= spinDecay;
    this.state.angularOffset[0] += this.angularVelocity[0] * dt;
    this.state.angularOffset[1] += this.angularVelocity[1] * dt;

    const velocityEnergy =
      this.state.strainVelocity * this.state.strainVelocity * 0.08 +
      length3(this.sloshVelocity) ** 2 * 0.06 +
      length3(this.bendVelocity) ** 2 * 0.1 +
      (this.angularVelocity[0] ** 2 + this.angularVelocity[1] ** 2) * 0.025 +
      this.state.torsionVelocity * this.state.torsionVelocity * 0.035;
    const potentialEnergy =
      this.state.strain * this.state.strain * 1.6 +
      length3(this.state.bend) ** 2 * 1.2 +
      this.state.torsion * this.state.torsion * 0.32 +
      this.state.contactPressure * this.state.contactPressure * 0.8;
    this.state.kineticEnergy = clamp(velocityEnergy + potentialEnergy, 0, 1.5);
  }
}

export function volumeScaleFromStrain(strain: number): Vec3Tuple {
  const axial = Math.exp(strain);
  const perpendicular = Math.exp(-strain * 0.5);
  return [perpendicular, perpendicular, axial];
}
