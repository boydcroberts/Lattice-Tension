import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  LineBasicMaterial,
  MathUtils,
  MeshBasicMaterial,
} from "three";
import { useExperienceStore } from "../experience/store";
import {
  organismController,
  SURFACE_WAVE_LIFETIME,
} from "../simulation/organismController";

type DetailProfile = {
  filaments: number;
  halos: number;
  ribbons: number;
  segments: number;
};

const DETAIL: Record<string, DetailProfile> = {
  high: { filaments: 42, halos: 9, ribbons: 6, segments: 32 },
  medium: { filaments: 30, halos: 7, ribbons: 5, segments: 26 },
  low: { filaments: 16, halos: 3, ribbons: 1, segments: 20 },
};

const VISUAL_INTENSITY: Record<string, number> = {
  high: 1,
  medium: 0.8,
  low: 0.38,
};

const PRIMARY = new Color("#096bd5");
const SECONDARY = new Color("#31c9f7");
const RIBBON = new Color("#5e78ff");
const SQUISH_VIOLET = new Color("#6872e6");
const TWIST_ORCHID = new Color("#9b79dc");

function fract(value: number) {
  return value - Math.floor(value);
}

function seeded(seed: number) {
  return fract(Math.sin(seed * 12.9898) * 43758.5453123);
}

function addLine(
  positions: number[],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
) {
  positions.push(ax, ay, az, bx, by, bz);
}

function makeGeometry(positions: number[]) {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function createFilamentGeometry(detail: DetailProfile) {
  const positions: number[] = [];

  for (let i = 0; i < detail.filaments; i += 1) {
    const r0 = seeded(i + 1);
    const r1 = seeded(i + 7.3);
    const r2 = seeded(i + 13.7);
    const radius = 0.22 + r0 * 1.22;
    const span = 1.15 + r1 * 3.6;
    const start = seeded(i + 22.2) * Math.PI * 2;
    const cx = (seeded(i + 41.2) - 0.5) * 0.9;
    const cy = (seeded(i + 51.8) - 0.5) * 0.68;
    const z = -0.12 - r2 * 1.2;
    const bow = (seeded(i + 68.5) - 0.5) * 0.5;
    const segments = Math.max(8, Math.round(detail.segments * (0.52 + r1 * 0.68)));

    for (let j = 0; j < segments; j += 1) {
      const a0 = start + (j / segments) * span;
      const a1 = start + ((j + 1) / segments) * span;
      const w0 = 1 + Math.sin(j * 0.77 + i) * 0.055;
      const w1 = 1 + Math.sin((j + 1) * 0.77 + i) * 0.055;
      const x0 = cx + Math.cos(a0) * radius * w0 + Math.sin(a0 * 0.5 + i) * 0.035;
      const y0 =
        cy + Math.sin(a0) * radius * 0.56 * w0 + Math.sin(a0 * 1.7) * bow * 0.16;
      const x1 = cx + Math.cos(a1) * radius * w1 + Math.sin(a1 * 0.5 + i) * 0.035;
      const y1 =
        cy + Math.sin(a1) * radius * 0.56 * w1 + Math.sin(a1 * 1.7) * bow * 0.16;
      const z0 = z + Math.sin(a0 * 1.3 + i) * 0.12;
      const z1 = z + Math.sin(a1 * 1.3 + i) * 0.12;
      addLine(positions, x0, y0, z0, x1, y1, z1);
    }
  }

  return makeGeometry(positions);
}

function createHaloGeometry(detail: DetailProfile) {
  const positions: number[] = [];

  for (let i = 0; i < detail.halos; i += 1) {
    const radius = 0.16 + i * 0.145;
    const squash = 0.34 + seeded(i + 91.4) * 0.38;
    const z = -0.35 - i * 0.12;
    const offsetX = (seeded(i + 101.4) - 0.5) * 0.2;
    const offsetY = (seeded(i + 117.9) - 0.5) * 0.16;
    const segments = detail.segments * 2;

    for (let j = 0; j < segments; j += 1) {
      const a0 = (j / segments) * Math.PI * 2;
      const a1 = ((j + 1) / segments) * Math.PI * 2;
      const pulse0 = 1 + Math.sin(a0 * 3 + i * 0.8) * 0.035;
      const pulse1 = 1 + Math.sin(a1 * 3 + i * 0.8) * 0.035;
      addLine(
        positions,
        offsetX + Math.cos(a0) * radius * pulse0,
        offsetY + Math.sin(a0) * radius * squash * pulse0,
        z + Math.sin(a0 * 2 + i) * 0.035,
        offsetX + Math.cos(a1) * radius * pulse1,
        offsetY + Math.sin(a1) * radius * squash * pulse1,
        z + Math.sin(a1 * 2 + i) * 0.035,
      );
    }
  }

  return makeGeometry(positions);
}

function createRibbonGeometry(detail: DetailProfile) {
  const positions: number[] = [];
  const indices: number[] = [];
  const segments = detail.segments * 2;

  for (let ribbon = 0; ribbon < detail.ribbons; ribbon += 1) {
    const phase = seeded(ribbon + 201.5) * Math.PI * 2;
    const baseY = -0.78 + seeded(ribbon + 217.5) * 1.62;
    const amp = 0.18 + seeded(ribbon + 229.9) * 0.36;
    const slope = (seeded(ribbon + 239.2) - 0.5) * 0.62;
    const z = 0.04 - seeded(ribbon + 251.9) * 0.42;
    const width = 0.012 + seeded(ribbon + 271.1) * 0.024;
    const base = positions.length / 3;

    for (let i = 0; i <= segments; i += 1) {
      const t = i / segments;
      const x = -1.62 + t * 3.24;
      const wave = Math.sin(t * Math.PI * 2.15 + phase);
      const y = baseY + wave * amp + (t - 0.5) * slope;
      const tangentX = 3.24;
      const tangentY =
        Math.cos(t * Math.PI * 2.15 + phase) * amp * Math.PI * 2.15 + slope;
      const invLen = 1 / Math.max(0.001, Math.hypot(tangentX, tangentY));
      const nx = -tangentY * invLen;
      const ny = tangentX * invLen;
      const taper = Math.sin(t * Math.PI);
      const w = width * (0.4 + taper * 1.15);

      positions.push(
        x + nx * w,
        y + ny * w,
        z + Math.sin(t * Math.PI * 2 + phase) * 0.04,
        x - nx * w,
        y - ny * w,
        z + Math.sin(t * Math.PI * 2 + phase) * 0.04,
      );

      if (i < segments) {
        const row = base + i * 2;
        indices.push(row, row + 1, row + 2, row + 1, row + 3, row + 2);
      }
    }
  }

  const geometry = makeGeometry(positions);
  geometry.setIndex(indices);
  return geometry;
}

export function SpectralStressField() {
  const group = useRef<Group>(null!);
  const tier = useExperienceStore((state) => state.profile?.tier ?? "high");
  const reducedMotion = useExperienceStore((state) => state.reducedMotion);

  const detail = DETAIL[tier] ?? DETAIL.high;
  const visualIntensity = VISUAL_INTENSITY[tier] ?? VISUAL_INTENSITY.high;
  const geometries = useMemo(
    () => ({
      filaments: createFilamentGeometry(detail),
      halos: createHaloGeometry(detail),
      ribbons: createRibbonGeometry(detail),
    }),
    [detail],
  );

  const materials = useMemo(
    () => ({
      filaments: new LineBasicMaterial({
        transparent: true,
        opacity: 0.36,
        blending: AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
      halos: new LineBasicMaterial({
        transparent: true,
        opacity: 0.24,
        blending: AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      }),
      ribbons: new MeshBasicMaterial({
        transparent: true,
        opacity: 0.12,
        blending: AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        side: DoubleSide,
      }),
    }),
    [],
  );

  useEffect(
    () => () => {
      geometries.filaments.dispose();
      geometries.halos.dispose();
      geometries.ribbons.dispose();
    },
    [geometries],
  );

  useEffect(
    () => () => {
      materials.filaments.dispose();
      materials.halos.dispose();
      materials.ribbons.dispose();
    },
    [materials],
  );

  useFrame(() => {
    const snapshot = organismController.snapshot;
    const time = snapshot.phase;
    const motion = reducedMotion ? 0.18 : 1;
    let waveWake = 0;
    let newestWave: (typeof snapshot.surfaceWaves)[number] | undefined;

    for (const wave of snapshot.surfaceWaves) {
      if (wave.age >= SURFACE_WAVE_LIFETIME) continue;
      const life = Math.max(0, 1 - wave.age / SURFACE_WAVE_LIFETIME);
      waveWake += wave.strength * life;
      if (!newestWave || wave.age < newestWave.age) newestWave = wave;
    }

    const waveProgress = newestWave
      ? MathUtils.clamp(newestWave.age / SURFACE_WAVE_LIFETIME, 0, 1)
      : 1;
    const wavePulse = newestWave
      ? newestWave.strength * Math.sin(waveProgress * Math.PI) * motion
      : 0;
    const ambientField =
      (0.012 + (Math.sin(time * 0.43) * 0.5 + 0.5) * 0.008) * motion;
    const fieldEnergy = MathUtils.clamp(
      (snapshot.energy * 0.85 +
        snapshot.resonance * 0.42 +
        waveWake * 0.24 +
        Math.abs(snapshot.squeeze) * 0.46 +
        Math.abs(snapshot.torsion) * 0.16 +
        ambientField) *
        visualIntensity,
      0,
      1.45,
    );
    const haloEnergy = MathUtils.clamp(
      (snapshot.resonance * 0.6 + waveWake * 0.42 + snapshot.energy * 0.18) *
        visualIntensity,
      0,
      1.35,
    );
    const ribbonEnergy = MathUtils.clamp(
      (snapshot.energy * 0.36 + waveWake * 0.2 + Math.abs(snapshot.squeeze) * 0.24) *
        visualIntensity,
      0,
      0.8,
    );
    const stretchColorStrength = MathUtils.clamp(
      (Math.max(0, snapshot.strain) * 3.15 + Math.hypot(...snapshot.bend) * 0.3) *
        visualIntensity,
      0,
      1,
    );
    const squishColorStrength = MathUtils.clamp(
      (Math.max(0, -snapshot.strain) * 3.4 +
        Math.max(0, snapshot.squeeze) * 0.72 +
        snapshot.contactPressure * 0.72) *
        visualIntensity,
      0,
      1,
    );
    const twistColorStrength = MathUtils.clamp(
      (Math.abs(snapshot.torsion) * 0.9 + Math.abs(snapshot.squeeze) * 0.16) *
        visualIntensity,
      0,
      1,
    );

    if (group.current) {
      group.current.visible = true;
      group.current.position.x =
        snapshot.position[0] +
        snapshot.slosh[0] * 0.045 +
        (newestWave?.origin[0] ?? 0) * wavePulse * 0.035;
      group.current.position.y =
        snapshot.position[1] +
        snapshot.slosh[1] * 0.035 +
        (newestWave?.origin[1] ?? 0) * wavePulse * 0.028;
      group.current.position.z = -0.08;
      group.current.rotation.x =
        snapshot.rotation[0] * 0.14 - (newestWave?.origin[1] ?? 0) * wavePulse * 0.04;
      group.current.rotation.y =
        snapshot.rotation[1] * 0.16 + (newestWave?.origin[0] ?? 0) * wavePulse * 0.045;
      group.current.rotation.z =
        time * 0.012 * motion +
        snapshot.rotation[2] * 0.34 +
        snapshot.torsion * 0.18 +
        wavePulse * 0.025;
      const breathing =
        1 +
        Math.sin(time * 0.43) * 0.016 * motion +
        snapshot.energy * 0.035 +
        waveWake * 0.025 +
        wavePulse * 0.035;
      group.current.scale.set(
        breathing * (1 + snapshot.slosh[0] * 0.05),
        breathing * (1 - snapshot.slosh[1] * 0.05),
        breathing,
      );
    }

    materials.filaments.color
      .copy(PRIMARY)
      .lerp(SECONDARY, stretchColorStrength * 0.76)
      .lerp(SQUISH_VIOLET, squishColorStrength * 0.46);
    materials.halos.color
      .copy(SECONDARY)
      .lerp(SQUISH_VIOLET, squishColorStrength * 0.62)
      .lerp(TWIST_ORCHID, twistColorStrength * 0.34);
    materials.ribbons.color
      .copy(RIBBON)
      .lerp(SECONDARY, stretchColorStrength * 0.5)
      .lerp(TWIST_ORCHID, twistColorStrength * 0.48);
    materials.filaments.opacity = MathUtils.clamp(
      0.012 + fieldEnergy * 0.1,
      0,
      0.2,
    );
    materials.halos.opacity = MathUtils.clamp(
      0.01 + haloEnergy * 0.085,
      0,
      0.16,
    );
    materials.ribbons.opacity = MathUtils.clamp(0.003 + ribbonEnergy * 0.075, 0, 0.1);
  });

  return (
    <group ref={group}>
      <mesh
        geometry={geometries.ribbons}
        material={materials.ribbons}
        frustumCulled={false}
        renderOrder={13}
      />
      <lineSegments
        geometry={geometries.halos}
        material={materials.halos}
        frustumCulled={false}
        renderOrder={13}
      />
      <lineSegments
        geometry={geometries.filaments}
        material={materials.filaments}
        frustumCulled={false}
        renderOrder={14}
      />
    </group>
  );
}
