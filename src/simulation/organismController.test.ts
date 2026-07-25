import { describe, expect, it } from "vitest";
import {
  OrganismController,
  SURFACE_WAVE_LIFETIME,
  isSurfaceContact,
  type Vec2Tuple,
} from "./organismController";

const advance = (controller: OrganismController, seconds: number, reducedMotion = false) => {
  for (let frame = 0; frame < Math.round(seconds * 60); frame += 1) {
    controller.advance(1 / 60, reducedMotion);
  }
};

describe("OrganismController", () => {
  it("rejects contacts that are not on the orb surface", () => {
    expect(isSurfaceContact([2, 0, 0])).toBe(false);
    expect(isSurfaceContact([0, 0, 0])).toBe(false);
    expect(isSurfaceContact([0.2, 0.2, 0.96])).toBe(true);
  });

  it("carries a surface wave across the body before it expires", () => {
    const controller = new OrganismController();
    expect(controller.beginContact([0, 0, 1])).toBe(true);
    controller.endContact([0, 0], 0);
    advance(controller, 0.1);

    expect(controller.snapshot.surfaceWaves.some((wave) => wave.age < 0.2)).toBe(true);
    expect(controller.snapshot.resonance).toBeGreaterThan(0);

    advance(controller, 3);
    expect(
      controller.snapshot.surfaceWaves.some(
        (wave) => wave.age < SURFACE_WAVE_LIFETIME && wave.strength > 0.1,
      ),
    ).toBe(true);

    advance(controller, 3);
    expect(
      controller.snapshot.surfaceWaves.every(
        (wave) => wave.age >= SURFACE_WAVE_LIFETIME - 0.05,
      ),
    ).toBe(true);
  });

  it("compacts live waves to the front and reports an accurate count", () => {
    const controller = new OrganismController();
    expect(controller.snapshot.liveWaveCount).toBe(0);

    // Eight taps at distinct points fill every ring-buffer slot.
    const points: Array<[number, number, number]> = [
      [0, 0, 1],
      [0.5, 0, 0.87],
      [-0.5, 0, 0.87],
      [0, 0.5, 0.87],
      [0, -0.5, 0.87],
      [0.35, 0.35, 0.87],
      [-0.35, 0.35, 0.87],
      [0.35, -0.35, 0.87],
    ];
    points.forEach((point, index) => {
      controller.beginContact(point, index);
      controller.endContact([0, 0], 0, index);
      advance(controller, 1 / 60);
    });

    const { liveWaveCount, liveWaves } = controller.snapshot;
    expect(liveWaveCount).toBe(8);
    // Every reported slot must actually be live — the shader loops over exactly
    // this range and never checks strength itself.
    for (let index = 0; index < liveWaveCount; index += 1) {
      expect(liveWaves[index]!.strength).toBeGreaterThan(0);
      expect(liveWaves[index]!.age).toBeLessThan(SURFACE_WAVE_LIFETIME);
    }
    expect(liveWaveCount).toBeLessThanOrEqual(liveWaves.length);

    // Once everything has decayed the loop should run zero times.
    advance(controller, 6);
    expect(controller.snapshot.liveWaveCount).toBe(0);
  });

  it("keeps surfaceWaves slot semantics for the ambient field", () => {
    const controller = new OrganismController();
    // SpectralStressField iterates every slot and filters by age itself.
    expect(controller.snapshot.surfaceWaves.length).toBe(
      controller.snapshot.liveWaves.length,
    );
    expect(
      controller.snapshot.surfaceWaves.every(
        (wave) => wave.age >= SURFACE_WAVE_LIFETIME && wave.strength === 0,
      ),
    ).toBe(true);
  });

  it("turns a release into bounded physical energy and a recovery", () => {
    const controller = new OrganismController();
    const velocity: Vec2Tuple = [2.4, -1.6];
    controller.beginContact([0.2, -0.15, 0.96]);
    controller.moveContact([0.45, -0.25, 0.86], [0.31, -0.18], velocity);
    controller.endContact(velocity, 0.38);
    advance(controller, 0.15);

    const peakEnergy = controller.snapshot.energy;
    expect(peakEnergy).toBeGreaterThan(0.08);
    expect(peakEnergy).toBeLessThanOrEqual(1.5);
    expect(Math.abs(controller.snapshot.strain)).toBeLessThanOrEqual(0.34);
    expect(Math.hypot(...controller.snapshot.slosh)).toBeGreaterThan(0.01);

    advance(controller, 8);
    expect(Math.abs(controller.snapshot.strain)).toBeLessThan(0.025);
    expect(controller.snapshot.energy).toBeLessThan(0.05);
  });

  it("combines simultaneous contacts into pinch, twist, and paired pressure", () => {
    const controller = new OrganismController();
    expect(controller.beginContact([-0.45, 0, 0.89], 11)).toBe(true);
    expect(controller.beginContact([0.45, 0, 0.89], 22)).toBe(true);

    controller.moveContact([-0.2, 0, 0.98], [0.25, 0], [1.2, 0], 11);
    controller.moveContact([0.2, 0, 0.98], [-0.25, 0], [-1.2, 0], 22);
    advance(controller, 0.45);

    expect(controller.snapshot.contactCount).toBe(2);
    expect(controller.snapshot.dragging).toBe(true);
    expect(controller.snapshot.squeeze).toBeGreaterThan(0.45);
    expect(controller.snapshot.strain).toBeLessThan(-0.06);
    expect(controller.snapshot.secondaryContactPressure).toBeGreaterThan(0.08);

    controller.moveContact([-0.14, -0.28, 0.95], [0.31, -0.28], [0.8, -1], 11);
    controller.moveContact([0.14, 0.28, 0.95], [-0.31, 0.28], [-0.8, 1], 22);
    advance(controller, 0.4);

    expect(controller.snapshot.torsion).toBeGreaterThan(0.15);

    controller.endContact([0.8, -1], 0.42, 11);
    advance(controller, 1 / 60);
    expect(controller.snapshot.contactCount).toBe(1);
    expect(controller.snapshot.dragging).toBe(true);
    controller.cancelContact(22);
    advance(controller, 1 / 60);
    expect(controller.snapshot.contactCount).toBe(0);
    expect(controller.snapshot.dragging).toBe(false);
  });

  it("caps a five-finger release and returns to equilibrium", () => {
    const controller = new OrganismController();
    const contacts: Array<[number, [number, number, number]]> = [
      [1, [-0.5, -0.18, 0.84]],
      [2, [-0.24, 0.3, 0.92]],
      [3, [0, -0.36, 0.93]],
      [4, [0.28, 0.28, 0.92]],
      [5, [0.5, -0.16, 0.85]],
    ];

    contacts.forEach(([pointerId, contact]) => {
      expect(controller.beginContact(contact, pointerId)).toBe(true);
    });
    expect(controller.beginContact([0, 0, 1], 6)).toBe(false);

    contacts.forEach(([pointerId, contact], index) => {
      const direction = index % 2 === 0 ? 1 : -1;
      controller.moveContact(
        contact,
        [direction * 0.18, -direction * 0.1],
        [direction * 2.4, -direction * 1.6],
        pointerId,
      );
      controller.endContact(
        [direction * 2.4, -direction * 1.6],
        0.3,
        pointerId,
      );
    });
    advance(controller, 0.2);

    expect(controller.snapshot.contactCount).toBe(0);
    expect(controller.snapshot.energy).toBeGreaterThan(0.08);
    expect(controller.snapshot.energy).toBeLessThanOrEqual(1.5);

    advance(controller, 10);
    expect(Math.abs(controller.snapshot.strain)).toBeLessThan(0.025);
    expect(Math.abs(controller.snapshot.torsion)).toBeLessThan(0.01);
    expect(controller.snapshot.energy).toBeLessThan(0.05);
  });

  it("limits idle movement under reduced motion", () => {
    const normal = new OrganismController();
    const reduced = new OrganismController();
    advance(normal, 2.2, false);
    advance(reduced, 2.2, true);

    const normalMotion = Math.hypot(...normal.snapshot.bend) + Math.hypot(...normal.snapshot.slosh);
    const reducedMotion = Math.hypot(...reduced.snapshot.bend) + Math.hypot(...reduced.snapshot.slosh);
    expect(reducedMotion).toBeLessThan(normalMotion);
  });

  it("returns every physical mode to equilibrium on reset", () => {
    const controller = new OrganismController();
    controller.beginContact([0.3, -0.2, 0.93]);
    controller.moveContact([0.42, -0.24, 0.87], [0.28, -0.17], [2.8, -1.9]);
    controller.endContact([2.8, -1.9], 0.42);
    advance(controller, 0.2);

    expect(controller.snapshot.energy).toBeGreaterThan(0.05);
    controller.reset();

    expect(controller.snapshot).toMatchObject({
      phase: 0,
      strain: 0,
      strainVelocity: 0,
      contactPressure: 0,
      energy: 0,
      resonance: 0,
      dragging: false,
    });
    expect(controller.snapshot.bend).toEqual([0, 0, 0]);
    expect(controller.snapshot.slosh).toEqual([0, 0, 0]);
    expect(controller.snapshot.spin).toEqual([0, 0]);
    expect(controller.snapshot.surfaceWaves.every((wave) => wave.strength === 0)).toBe(true);
  });
});
