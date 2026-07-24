# Aesther — Deeper Material Physics

**Date:** 2026-07-24
**Status:** Design, approved for planning
**Scope:** Simulation and shader physics only.

## Goal

Deepen how Aesther's material *behaves* under touch. The orb today is a well-built
modal solver, but every mode is a damped spring returning to zero in one frequency
band, and every touch is treated identically regardless of how fast it happens. The
result reads as an excellent jelly rather than as matter.

Four changes, all in the physics.

## Non-goals

- No behavioral layer (anticipation, flinch, attention, hover response).
- No persistent or accumulating session state.
- No revisiting the rest-state visual treatment (void, environment, idle lighting).
  Those are real observations, recorded below under Deferred, and are a separate piece
  of work.
- No new optical features in the shader. Dispersion changes how existing waves
  propagate; it does not add a new visual vocabulary.

## Constraint: hold current GPU cost

The ripple sum at `jellyOrbMaterial.ts:230-233` sits inside `map()` — the SDF — which
runs every march step. At `high: 128` steps (`JellyOrb.tsx:8`), four unrolled waves
cost ~512 `acos`+`exp`+`sin` per pixel per frame, full-screen at up to 1.4 DPR. This is
the dominant cost in the piece and the binding constraint on everything below.

Net effect of this work on that budget:

| state | today | after |
| --- | --- | --- |
| rest | 512 | 0 |
| typical touch (1–3 live waves) | 512 | 128–384 |
| peak (8 live waves) | 512 | 1024, transient |

Cheaper in the common case, more headroom at the peak.

## Resolved risk: TSL dynamic `Loop` on the WebGL backend

Change 4 depends on `Loop()` with a runtime uniform count over a `uniformArray`,
nested inside the march loop, on Three's **WebGL** TSL backend (the app's default —
WebGPU is an explicit `?webgpu` opt-in, `ExperienceCanvas.tsx:157-166`).

Spiked before writing this spec. `src/__spike/loopSpike.ts` renders a nested
`Loop(OUTER)` / `Loop(liveCount)` sum of a `uniformArray`, reads back exact pixel
values, and reports `backend: "WebGL"`:

| liveCount | 0 | 1 | 2 | 4 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- |
| expected | 0 | 0.028 | 0.083 | 0.278 | 0.778 | 1.0 |
| measured | 0 | 0.027 | 0.082 | 0.278 | 0.776 | 1.0 |

All six cases within 8-bit readback tolerance. `Loop`, `If`, `uniformArray`, `Break`
and `select` are all exported from `three/tsl` at three 0.184.0. The approach is sound.

The spike (`spike-loop.html`, `src/__spike/loopSpike.ts`, and
`~/agents/aether-verify/spike.mjs`) stays in place as a regression guard during
implementation. `spike-loop.html` and `src/__spike/` are deleted before the work lands;
the runner in `~/agents/` is kept.

### TSL typing gaps in @types/three 0.184.1

The spike surfaced three gaps between the TSL runtime and its TypeScript
definitions. The implementation will hit all three, so the working forms are
recorded here.

`uniform()` is declared as `(value: number, type?: "float")` with **no `"int"`
overload** (`@types/three/src/nodes/core/UniformNode.d.ts:93-105`), so an int uniform
cannot be expressed directly. Hold the count as a float uniform and convert at the
point of use:

```ts
const liveCount = uniform(0);                                   // float uniform
Loop({ start: 0, end: int(liveCount), type: "int" }, ({ i }) => { ... });
```

`Loop()`'s first overload takes a plain `number`; a runtime-varying bound requires the
object form `{ start, end, type }`, where `end` accepts `Node<"int"> | number`
(`LoopNode.d.ts:6-15, 27-38`).

`uniformArray()` infers its element type from the generic, not the string argument, so
swizzles on `.element(i)` need it stated explicitly — `uniformArray<"vec4">(slots,
"vec4")` — or the element widens to `ArrayElementNode<string>` and `.x` fails to
resolve.

Note that Vite's dev server does not typecheck, so none of this appears until
`tsc -b` runs in `npm run build`. Typecheck before assuming a TSL change is sound.

---

## Change 1 — Rate-dependent viscosity

**Where:** `src/simulation/jellyDynamics.ts`. CPU only, no GPU cost.

`dragCompliance` is a constant `0.62` (`jellyDynamics.ts:52`, applied at `:194`), so a
slow pull and a fast yank to the same displacement produce identical strain. Real soft
matter is non-Newtonian: it resists fast deformation and flows under slow load.

Add a low-passed shear-rate estimate and make both compliance and damping functions
of it:

```
shearRate += (clamp(dragRate, 0, 5) - shearRate) * (1 - exp(-shearRateLag * dt))

effectiveCompliance = dragCompliance / (1 + shearThickening * shearRate)
effectiveDamping    = min(dampingCeiling, damping * (1 + viscousGain * shearRate))
```

The exponential lag form matches the existing `spinDecay` idiom (`:263`) and is
step-size stable.

**Plumbing:** `OrganismController.step()` already computes
`activeVelocity = length2(this.input.velocity)` (`organismController.ts:410`) but does
not forward it. Add `dragRate?: number` to `JellyDynamicsInput` and pass it.
Expose `shearRate` on `JellyDynamicsState` — Change 2 consumes it.

**Starting constants** (`DEFAULT_CONFIG`): `shearThickening: 0.42`,
`viscousGain: 0.55`, `shearRateLag: 6.5`, `dampingCeiling: 24`. These are starting
points to be tuned against captures, not settled values.

**Stability:** at rest ζ ≈ 0.48 (underdamped, unchanged). At maximum shear rate,
damping reaches `4.15 × 2.75 = 11.4`, ζ ≈ 1.31 — deliberately overdamped, which is the
intended "fast feels solid" behavior. Semi-implicit Euler at `dt = 1/120` needs
`damping * dt < 2`; `dampingCeiling: 24` gives `0.2`, an order of magnitude of margin.

**Felt result:** pull slowly and it flows like syrup; yank it and it resists, then
releases with more overshoot.

---

## Change 2 — Surface-tension skin mode

**Where:** `src/simulation/jellyDynamics.ts` (new mode), `src/visuals/JellyOrb.tsx`
(uniform mapping). No new shader term.

Every existing mode — strain, bend, slosh, torsion, pressure — sits in the same low
frequency band (bulk ω = √19 ≈ 4.4 rad/s). That single band is a real part of why the
orb reads as a spring. Surface tension has a much higher natural frequency: short
wavelength, strong restoring force.

Add one lightly-damped scalar mode driven by how far the shape is from a sphere:

```
deformation = |strain| + |bend| * 0.8 + |torsion| * 0.4
skinTarget  = -deformation * skinCoupling
skinAcc     = (skinTarget - skin) * skinStiffness - skinVelocity * skinDamping
```

**Constants:** `skinStiffness: 190`, `skinDamping: 2.4`, `skinCoupling: 0.16`.

ω = √190 ≈ 13.8 rad/s ≈ 2.2 Hz — about 3.2× the bulk frequency, a clear separation.
ζ = 2.4 / (2 × 13.8) ≈ 0.087, so it rings for roughly 1–2 s after a release before
settling. At 120 Hz that is ~54 samples per cycle; `skinStiffness * dt² = 0.013`, well
inside explicit-integrator stability.

**Zero GPU cost.** Rather than adding a shader term, `skin` is summed into the strain
fed to the existing `squash` uniform in `JellyOrb.tsx`:

```
squash.value = snapshot.strain + snapshot.skin
```

This routes the skin mode through the existing volume-preserving axial deformation
(`volumeScaleFromStrain`, `jellyDynamics.ts:284`), which makes it the l=2 quadrupole —
the physically correct oscillation mode for an incompressible droplet, and free.
`snapshot.strain` keeps its current meaning so existing assertions stay valid.

**Felt result:** a fast silhouette shimmer riding on top of the slow body slosh —
wobble on the wobble.

---

## Change 3 — Dispersive waves

**Where:** `rippleWave` in `src/visuals/jellyOrbMaterial.ts:112-128`. GPU cost-neutral.

Current phase speed is fixed: `front = age * 0.78`, `sin(dist * 10.5 - age * 3.0)`.
Every wavelength travels at the same speed, so an impact stays a clean ring forever.
Real capillary waves are dispersive — short wavelengths outrun long ones, and an
impact spreads into a chirped packet.

Make the wavenumber vary across the packet, so wavelength compresses ahead of the
front and stretches behind it:

```
k    = clamp(kBase + delta * dispersionGain, kMin, kMax)
wave = sin(dist * k - age * 3.0)
```

This is a stationary-phase approximation shaped like real dispersion, not a solve of
the capillary dispersion relation. It costs a few mul/adds inside a function already
paying for `acos` + `exp` + `sin` — the transcendental count is unchanged.

**This change requires widening the envelope, and that is not optional.** The current
envelope is `exp(-delta² * 34)`, σ ≈ 0.12 rad. At `k = 10.5` one wavelength is
2π/10.5 ≈ 0.60 rad — so the envelope is about **one fifth of a single wavelength**.
Today's "wave" is effectively one crest, and a chirp inside it would be invisible.

Proposed retune: envelope coefficient `34 → 12` (σ ≈ 0.20 rad), `kBase 10.5 → 14`
(wavelength 0.45 rad). That fits roughly 2–3 crests in the packet, which is the
minimum for dispersion to read at all.

**Constants:** `kBase: 14`, `dispersionGain: 3.0`, `kMin: 5.0`, `kMax: 16.0`,
envelope coefficient `12`.

**Per-wave amplitude must be k-compensated.** SDF gradient scales with
`amplitude × k`, so raising k raises overstep risk directly. The count normalization
in Change 4 does not cover this — at 4 live waves that normalization is exactly 1.0,
which would leave the gradient 16/10.5 ≈ 1.52× today's. Compensate inside
`rippleWave` itself:

```
return wave.mul(envelope).mul(strength).mul(kBase / k)
```

One divide, and it holds per-wave gradient constant no matter what k does. Dispersion
is carried by phase and wavelength, not amplitude, so this costs nothing visually.
With this in place the two normalizations are orthogonal: `kBase / k` handles
wavenumber, `min(1, 2 / sqrt(liveCount))` handles count.

Still pixel-verified rather than assumed.

**This visibly changes how existing waves look.** Per the repo standard, the tuned
values in any test that asserts against them are updated in the same commit as the
change that moves them, and reference captures are refreshed alongside.

---

## Change 4 — Wave capacity 4 → 8, paid for by compaction

**Where:** `src/simulation/organismController.ts`, `src/visuals/jellyOrbMaterial.ts`,
`src/visuals/JellyOrb.tsx`.

The four slots are unrolled and evaluated unconditionally, but their strengths are
uniforms and the ring buffer decays (`organismController.ts:445`). At rest the orb
pays the full ~512 transcendentals per pixel to render four dead waves — every frame,
in the state the user spends most of their time in.

**Controller side:**

- `WAVE_COUNT: 4 → 8`.
- Keep the existing ring buffer and spawn logic unchanged.
- Each step, compact into a preallocated `liveWaves` array: a wave is live when
  `strength * life > 0.004`. Sort by `strength * life` descending and take up to 8, so
  that if spawns ever exceed capacity the strongest survive.
- Expose `liveWaves` and `liveWaveCount` on the snapshot **alongside** the existing
  `surfaceWaves`, not replacing it.

Keeping `surfaceWaves` intact matters: `SpectralStressField.tsx:257-262` iterates it
and already filters dead waves itself, so that consumer is untouched by this change.
(`useAetherAudio.ts` does not read waves at all.) Only `JellyOrb.tsx:97-100`, which
indexes slots 0–3 explicitly, is rewritten.

**Shader side:**

- Replace the twelve individual ripple uniforms with two uniform arrays of length 8 —
  `vec4(origin.xyz, strength)` and a `float` array of ages — plus an int `liveCount`.
- Replace the manual unroll at `:230-233` with `Loop(liveCount, ...)` accumulating
  into a `.toVar()`. Compaction guarantees slots `0..liveCount-1` are all live, so no
  per-slot branch is needed.
- **Count normalization for march safety.** Incoherent superposition of N waves grows
  as √N. Scale the sum by `min(1, 2 / sqrt(liveCount))`, which reproduces today's
  amplitude exactly at 1–4 waves and gives 0.707× at 8. Together with the `kBase / k`
  per-wave compensation from Change 3, this keeps the added SDF gradient inside what
  the sphere-trace tolerates. The existing comment at `:226-228` records that amplitude
  0.05 already caused overstep, so this is a live hazard, not a theoretical one.

**Refactor:** the unroll removal plus extracting the ripple field into
`src/visuals/rippleField.ts` brings `jellyOrbMaterial.ts` back under the 800-line flag
(currently 1036). This is scoped to the code being changed, not a general cleanup.

---

## Verification

Every change except dispersion is deterministic and testable against the existing
fixed-step harness (`jellyDynamics.test.ts`, `organismController.test.ts`).

**Simulation:**

- Fast vs. slow drag to identical displacement produces a lower peak `|strain|` on the
  fast path.
- After an impulse, `skin` changes sign at least 3 times within 1 s (rings near
  2.2 Hz) and decays below 5% of peak within 3 s.
- 10 s of maximum-rate input produces no NaN and no divergence in any mode.
- Eight rapid spawns give `liveWaveCount === 8` with live slots contiguous; after 6 s
  of decay, `liveWaveCount === 0`; more than 8 spawns keeps the 8 strongest.
- `surfaceWaves` retains its current length-and-slot semantics for
  `SpectralStressField`.

**Shader (pixel verification, via `~/agents/aether-verify/orb.mjs`):**

- At peak wave count and `k = kMax`, the silhouette has no black speckles or holes —
  minimum luma inside the silhouette stays above threshold and coverage stays stable
  against the rest-state baseline. This is the overstep check and it is the one that
  cannot be skipped. It must be run at all three tiers, since `low: 48` march steps
  tolerates far less gradient than `high: 128`.
- Rest-state frame stats stay within tolerance of today's baseline (mean 2.5,
  coverage 0.043), confirming no unintended visual regression.

**Gate:** `npm run test`, `npm run lint`, `npm run build` all green, with output
quoted, before any completion claim.

---

## Deferred — rest-state observations

Recorded here so they are not lost; explicitly out of scope for this work.

Measured from `~/agents/screenshots/aether-orb/`: at rest the frame is mean luma
2.5/255, coverage 4.3%, edge luma exactly 0, and channel means R 0.1 / G 1.8 / B 11.9 —
a near-monochrome dark navy blob on pure black. Under drag it reaches mean 7.9 with
visible interference and real deformation.

The optical vocabulary is all authored and present — chromatic dispersion (`:534`),
thin-film iridescence (`:436`), Beer-Lambert absorption (`:525`), depth-stacked
caustics (`:596`), procedural sky (`:398`) — but suppressed at idle by the
energy-gated post stack (`TslBloom.tsx:119-125`: exposure 0.50, bloom 0.14,
threshold 0.90). The piece is substantially invisible until touched.

The three candidate directions, if this is picked up later: give the void an
environment to reflect (the rim cannot read against `#000000`); establish a non-zero
idle energy floor; and break the single-hue palette with a warm counter-light.
