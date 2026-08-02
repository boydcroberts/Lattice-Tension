import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Color, type Intersection, type Mesh, type Raycaster } from "three";
import { useExperienceStore } from "../experience/store";
import { organismController } from "../simulation/organismController";
import { createJellyOrbMaterial } from "./jellyOrbMaterial";

const STEPS: Record<string, number> = { high: 128, medium: 68, low: 48 };
const REDUCED_MOTION_SCALE = 0.18;

// Deliberately cool and low-luminance. The shader does the bright work through
// wet highlights and bloom; these anchors keep the body from bleaching white.
const DEEP = new Color("#07539d");
const OCEAN = new Color("#1bb7ee");
const BABY_BLUE = new Color("#a0ecff");
const VIOLET = new Color("#7180ff");
const STRETCH_CYAN = new Color("#20b8ea");
const SQUISH_VIOLET = new Color("#6872e6");
const TWIST_ORCHID = new Color("#9b79dc");
const ACTIVE_ACCENT = new Color();
const ACTIVE_HIGHLIGHT = new Color();

// The shader's bounding cube is only a render envelope. ContactSurface is the
// sole interaction volume, so the cube must never compete for pointer hits.
const skipRaycast = (...args: [Raycaster, Intersection[]]) => {
  void args;
};

/**
 * Upload the compacted live waves. Only the first `liveWaveCount` slots are read
 * by the shader loop, so stale data past that point is inert and does not need
 * clearing — writing it would be pure waste at 120 Hz.
 */
function uploadWaves(
  ripple: ReturnType<typeof createJellyOrbMaterial>["ripple"],
  snapshot: (typeof organismController)["snapshot"],
) {
  const count = Math.min(snapshot.liveWaveCount, ripple.slots.length);
  for (let index = 0; index < count; index += 1) {
    const wave = snapshot.liveWaves[index]!;
    ripple.slots[index]!.set(wave.origin[0], wave.origin[1], wave.origin[2], wave.strength);
    ripple.ages[index] = wave.age;
  }
  ripple.liveCount.value = count;
}

export function JellyOrb() {
  const mesh = useRef<Mesh>(null!);
  const tier = useExperienceStore((state) => state.profile?.tier ?? "high");
  const reducedMotion = useExperienceStore((state) => state.reducedMotion);
  const uniforms = useMemo(() => createJellyOrbMaterial(STEPS[tier] ?? 110), [tier]);

  useEffect(() => () => uniforms.material.dispose(), [uniforms]);

  useFrame(() => {
    const snapshot = organismController.snapshot;
    const energy = snapshot.energy;
    const resonance = snapshot.resonance;
    // Low-tier devices keep the exact same body physics, but spend fewer bright
    // optical layers so an energetic pull stays deep-water blue rather than
    // bleaching into a flat cyan fill without the desktop post stack.
    const visualScale = tier === "low" ? 0.64 : tier === "medium" ? 0.84 : 1;
    const visualEnergy = energy * visualScale;
    const visualResonance = resonance * visualScale;
    const bendAmount = Math.hypot(...snapshot.bend);
    const stretchColorStrength = Math.min(
      1,
      (Math.max(0, snapshot.strain) * 3.15 + bendAmount * 0.3 + energy * 0.1) *
        visualScale,
    );
    const squishColorStrength = Math.min(
      1,
      (Math.max(0, -snapshot.strain) * 3.4 +
        Math.max(0, snapshot.squeeze) * 0.72 +
        snapshot.contactPressure * 0.72) *
        visualScale,
    );
    const twistColorStrength = Math.min(
      1,
      (Math.abs(snapshot.torsion) * 0.9 +
        Math.abs(snapshot.squeeze) * 0.16 +
        resonance * 0.04) *
        visualScale,
    );

    uniforms.phase.value = snapshot.phase;
    uniforms.motionScale.value = reducedMotion ? REDUCED_MOTION_SCALE : 1;
    // Bulk strain plus the fast surface-tension mode. Summing them here routes
    // the skin through volumeScaleFromStrain's volume-preserving axial/perpendicular
    // split, which makes it the l=2 quadrupole — the right oscillation mode for an
    // incompressible droplet — without costing a single shader instruction.
    uniforms.squash.value = snapshot.strain + snapshot.skin;
    uniforms.jiggle.value.set(...snapshot.axis);
    uniforms.bend.value.set(...snapshot.bend);
    uniforms.slosh.value.set(...snapshot.slosh);
    uniforms.kineticEnergy.value = visualEnergy;
    uniforms.contactOrigin.value.set(...snapshot.contactOrigin);
    uniforms.contactPressure.value = snapshot.contactPressure * visualScale;
    uniforms.secondaryContactOrigin.value.set(...snapshot.secondaryContactOrigin);
    uniforms.secondaryContactPressure.value = snapshot.secondaryContactPressure * visualScale;
    uniforms.pointer.value.set(...snapshot.pointer);

    uploadWaves(uniforms.ripple, snapshot);

    uniforms.speed.value = 0.27 + energy * 0.22;
    uniforms.tension.value = 0.39 + visualEnergy * 0.48 + visualResonance * 0.14;
    uniforms.order.value = 0.22 + visualEnergy * 0.3 + visualResonance * 0.12;
    uniforms.pulse.value = Math.min(0.94, visualEnergy * 0.66 + visualResonance * 0.38);
    uniforms.resonance.value = visualResonance;
    uniforms.presence.value = 1;
    uniforms.collapseDistort.value = 0;
    uniforms.fringeRipple.value = visualEnergy * 0.045;
    uniforms.lattice.value = 0.28 + visualEnergy * 0.27 + visualResonance * 0.12;
    uniforms.stretchColorStrength.value = stretchColorStrength;
    uniforms.squishColorStrength.value = squishColorStrength;
    uniforms.twistColorStrength.value = twistColorStrength;
    uniforms.stretchColor.value.copy(STRETCH_CYAN);
    uniforms.squishColor.value.copy(SQUISH_VIOLET);
    uniforms.twistColor.value.copy(TWIST_ORCHID);

    ACTIVE_ACCENT
      .copy(OCEAN)
      .lerp(STRETCH_CYAN, stretchColorStrength * 0.32)
      .lerp(SQUISH_VIOLET, squishColorStrength * 0.24)
      .lerp(TWIST_ORCHID, twistColorStrength * 0.12);
    ACTIVE_HIGHLIGHT
      .copy(BABY_BLUE)
      .lerp(STRETCH_CYAN, stretchColorStrength * 0.24)
      .lerp(SQUISH_VIOLET, squishColorStrength * 0.2)
      .lerp(TWIST_ORCHID, twistColorStrength * 0.12);
    uniforms.tint.value.copy(DEEP).lerp(OCEAN, stretchColorStrength * 0.03);
    uniforms.accent.value.copy(ACTIVE_ACCENT);
    uniforms.highlight.value.copy(ACTIVE_HIGHLIGHT).lerp(VIOLET, visualEnergy * 0.04);

    if (!mesh.current) return;
    mesh.current.position.set(...snapshot.position);
    mesh.current.rotation.set(...snapshot.rotation);
    mesh.current.scale.setScalar(snapshot.modelScale);
  });

  return (
    <mesh ref={mesh} renderOrder={15} raycast={skipRaycast}>
      <boxGeometry args={[1, 1, 1]} />
      <primitive object={uniforms.material} attach="material" />
    </mesh>
  );
}
