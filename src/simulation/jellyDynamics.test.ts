import { describe, expect, it } from "vitest";
import { JellyDynamics, volumeScaleFromStrain } from "./jellyDynamics";

const idleInput = {
  dragX: 0,
  dragY: 0,
  dragging: false,
  idleTarget: 0,
  motionScale: 1,
};

const restInput = { ...idleInput, motionScale: 0 };

describe("JellyDynamics", () => {
  it("preserves volume for axial deformation", () => {
    for (const strain of [-0.2, -0.05, 0, 0.18, 0.34]) {
      const [x, y, z] = volumeScaleFromStrain(strain);
      expect(x * y * z).toBeCloseTo(1, 8);
    }
  });

  it("settles after an impulse without accumulating drift", () => {
    const jelly = new JellyDynamics();
    jelly.applyImpulse([0.5, 0.7, 0.4], 1);

    for (let frame = 0; frame < 60 * 8; frame += 1) {
      jelly.advance(1 / 60, restInput);
    }

    expect(Math.abs(jelly.state.strain)).toBeLessThan(0.002);
    expect(Math.abs(jelly.state.strainVelocity)).toBeLessThan(0.004);
    expect(jelly.state.kineticEnergy).toBeLessThan(0.002);
  });

  it("turns a multi-contact pinch and twist into bounded squish", () => {
    const jelly = new JellyDynamics();

    for (let frame = 0; frame < 60; frame += 1) {
      jelly.advance(1 / 60, {
        ...idleInput,
        dragging: true,
        contactStrength: 0.72,
        squeeze: 0.62,
        twist: 0.7,
      });
    }

    expect(jelly.state.strain).toBeLessThan(-0.08);
    expect(jelly.state.contactPressure).toBeGreaterThan(0.12);
    expect(jelly.state.torsion).toBeGreaterThan(0.2);
    expect(jelly.state.torsion).toBeLessThanOrEqual(0.82);

    for (let frame = 0; frame < 60 * 8; frame += 1) {
      jelly.advance(1 / 60, restInput);
    }

    expect(Math.abs(jelly.state.torsion)).toBeLessThan(0.003);
    expect(Math.abs(jelly.state.torsionVelocity)).toBeLessThan(0.005);
  });

  it("resists a fast pull more than a slow one to the same displacement", () => {
    // Same final displacement, different approach speed. Shear thickening means
    // the fast path should reach a smaller strain, not the same one.
    const pullTo = (dragRate: number) => {
      const jelly = new JellyDynamics();
      let peak = 0;
      for (let frame = 0; frame < 120; frame += 1) {
        jelly.advance(1 / 120, {
          ...idleInput,
          dragging: true,
          dragX: 0.4,
          dragY: 0,
          dragRate,
        });
        peak = Math.max(peak, Math.abs(jelly.state.strain));
      }
      return peak;
    };

    const slow = pullTo(0);
    const fast = pullTo(4.5);

    expect(fast).toBeLessThan(slow);
    expect(fast).toBeGreaterThan(0);
  });

  it("keeps the shear-rate response frame-rate independent", () => {
    const run = (fps: number) => {
      const jelly = new JellyDynamics();
      for (let frame = 0; frame < fps; frame += 1) {
        jelly.advance(1 / fps, {
          ...idleInput,
          dragging: true,
          dragX: 0.35,
          dragY: 0.1,
          dragRate: 3.2,
        });
      }
      return jelly.state;
    };

    const at30 = run(30);
    const at60 = run(60);
    const at120 = run(120);

    expect(at30.shearRate).toBeCloseTo(at120.shearRate, 4);
    expect(at30.strain).toBeCloseTo(at60.strain, 4);
    expect(at60.strain).toBeCloseTo(at120.strain, 4);
  });

  it("stays finite under sustained maximum-rate input", () => {
    const jelly = new JellyDynamics();
    for (let frame = 0; frame < 120 * 10; frame += 1) {
      jelly.advance(1 / 120, {
        ...idleInput,
        dragging: true,
        dragX: 0.7,
        dragY: -0.7,
        dragRate: 99,
        contactStrength: 1,
        squeeze: 0.8,
        twist: 1.1,
      });
    }

    const { state } = jelly;
    for (const value of [
      state.strain,
      state.strainVelocity,
      state.torsion,
      state.contactPressure,
      state.kineticEnergy,
      state.shearRate,
      ...state.bend,
      ...state.slosh,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    // Rate is clamped before it reaches the material, however large the input.
    expect(state.shearRate).toBeLessThanOrEqual(5);
    expect(Math.abs(state.strain)).toBeLessThanOrEqual(0.34);
  });

  it("rings the surface-tension mode above the bulk band, then settles", () => {
    const jelly = new JellyDynamics();
    jelly.applyImpulse([0.3, 0.8, 0.5], 1.2);

    // Direction reversals, not zero crossings: the skin oscillates about a
    // negative target (deformation always pulls it inward), so it rarely crosses
    // zero even while ringing hard. Reversals count the oscillation itself.
    let skinReversals = 0;
    let strainReversals = 0;
    let peak = 0;
    let previousSkinVelocity = jelly.state.skinVelocity;
    let previousStrainVelocity = jelly.state.strainVelocity;

    for (let frame = 0; frame < 120; frame += 1) {
      jelly.advance(1 / 120, idleInput);
      const { skinVelocity, strainVelocity, skin } = jelly.state;
      if (Math.sign(skinVelocity) !== Math.sign(previousSkinVelocity) && skinVelocity !== 0) {
        skinReversals += 1;
      }
      if (Math.sign(strainVelocity) !== Math.sign(previousStrainVelocity) && strainVelocity !== 0) {
        strainReversals += 1;
      }
      peak = Math.max(peak, Math.abs(skin));
      previousSkinVelocity = skinVelocity;
      previousStrainVelocity = strainVelocity;
    }

    // The whole point of the mode is a band separation from the bulk (~0.7 Hz).
    expect(skinReversals).toBeGreaterThanOrEqual(4);
    expect(skinReversals).toBeGreaterThan(strainReversals);
    expect(peak).toBeGreaterThan(0);

    // Undriven, the ring decays away rather than sustaining.
    for (let frame = 0; frame < 120 * 3; frame += 1) {
      jelly.advance(1 / 120, restInput);
    }
    expect(Math.abs(jelly.state.skin)).toBeLessThan(peak * 0.05);
  });

  it("is stable across common render frame rates", () => {
    const run = (fps: number) => {
      const jelly = new JellyDynamics();
      jelly.applyFlick(0.2, -0.14, 1.2);
      for (let frame = 0; frame < fps * 3; frame += 1) {
        jelly.advance(1 / fps, idleInput);
      }
      return jelly.state;
    };

    const at30 = run(30);
    const at60 = run(60);
    const at120 = run(120);

    expect(at30.strain).toBeCloseTo(at60.strain, 4);
    expect(at60.strain).toBeCloseTo(at120.strain, 4);
    expect(at30.slosh[0]).toBeCloseTo(at120.slosh[0], 4);
    expect(at30.angularOffset[1]).toBeCloseTo(at120.angularOffset[1], 4);
  });
});
