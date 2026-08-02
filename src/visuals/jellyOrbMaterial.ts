/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck — TSL node DSL: runtime-correct, but its operator types can't be
// modeled by TypeScript. App code outside this shader stays fully type-checked.
import { Color, FrontSide, Vector2, Vector3 } from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  acos,
  abs,
  cos,
  cross,
  dot,
  exp,
  float,
  floor,
  fract,
  length,
  max,
  min,
  mix,
  normalize,
  pow,
  reflect,
  refract,
  sin,
  smoothstep,
  screenSize,
  screenUV,
  step,
  uniform,
  vec3,
  vec4,
  cameraPosition,
  positionGeometry,
  modelWorldMatrixInverse,
} from 'three/tsl';
import { RaymarchingBox } from 'three/examples/jsm/tsl/utils/Raymarching.js';
import { createRippleField } from './rippleField';

/**
 * A raymarched water-glass organism. It consumes the modal controller snapshot:
 *  - multi-octave domain-warp wobble + twin travelling ripples
 *  - slow independent breathing + a glacial silhouette morph
 *  - ocean-blue absorption, a wet fresnel rim, and moving internal caustics
 *  - sparse submerged stress traces, visible only when the organism carries energy
 */
export function createJellyOrbMaterial(steps: number) {
  const tension = uniform(0.4);
  const order = uniform(0);
  const speed = uniform(0.6);
  const phase = uniform(0);
  const motionScale = uniform(1);
  const pulse = uniform(0);
  const tint = uniform(new Color('#003366')); // deeper ocean glass
  const accent = uniform(new Color('#88e0ff')); // brighter rim and caustics
  const highlight = uniform(new Color('#e0faff')); // enhanced wet glints
  const stretchColor = uniform(new Color('#20b8ea'));
  const squishColor = uniform(new Color('#6872e6'));
  const twistColor = uniform(new Color('#9b79dc'));
  const stretchColorStrength = uniform(0);
  const squishColorStrength = uniform(0);
  const twistColorStrength = uniform(0);
  const lattice = uniform(0.14);
  const resonance = uniform(0);
  const presence = uniform(1);
  const collapseDistort = uniform(0);
  const fringeRipple = uniform(0);
  const pointer = uniform(new Vector2());
  const jiggle = uniform(new Vector3(0, 1, 0)); // wobble axis (spring-driven)
  const squash = uniform(0); // logarithmic axial strain from the jelly solver
  const bend = uniform(new Vector3()); // low-frequency shear modes
  const slosh = uniform(new Vector3()); // delayed liquid mass moving inside shell
  const kineticEnergy = uniform(0);
  const contactOrigin = uniform(new Vector3(0, 0, 1));
  const contactPressure = uniform(0);
  const secondaryContactOrigin = uniform(new Vector3(0, 0, 1));
  const secondaryContactPressure = uniform(0);
  const stepCount = uniform(steps);
  const animationPhase = phase.mul(motionScale);

  // Fluid memory: a ring buffer of the last touches, each a direction on the orb
  // (where the touch landed) plus how long ago it fired. Age is accumulated on the
  // CPU side every frame (JellyOrb.tsx), not from shader `time`, so it stays
  // correct regardless of when the material was created relative to the renderer's
  // own clock. The controller compacts live waves to the front and publishes the
  // count, so an idle orb loops zero times and the ripple sum genuinely costs
  // nothing — see rippleField.ts.
  const ripple = createRippleField();

  // gyroid field — the hidden geometry suspended inside the jelly
  const gyroid = (x: ReturnType<typeof vec3>) =>
    sin(x.x).mul(cos(x.y)).add(sin(x.y).mul(cos(x.z))).add(sin(x.z).mul(cos(x.x)));

  const map = (p: ReturnType<typeof vec3>) => {
    // Volume-preserving axial strain. These are inverse scales because an SDF
    // deforms by transforming its query point. axial * perpendicular² = 1.
    const ax = normalize(jiggle.add(vec3(0.0, 0.0001, 0.0)));
    const al = dot(p, ax);
    const perp = p.sub(ax.mul(al));
    const axialScale = exp(squash);
    const perpendicularScale = exp(squash.mul(-0.5));
    const volumePoint = perp
      .div(perpendicularScale)
      .add(ax.mul(al.div(axialScale)));
    // The first two soft modes bend the volume rather than moving it as a
    // rigid object. Their quadratic profile pins the centre and exaggerates
    // the delayed, floppy silhouette at the poles.
    const bendProfile = volumePoint.z.mul(volumePoint.z).sub(0.12);
    const pt = volumePoint.add(
      vec3(
        bend.x.mul(bendProfile),
        bend.y.mul(bendProfile),
        bend.z.mul(volumePoint.x.mul(volumePoint.y)),
    ).mul(0.92),
    );
    const t = animationPhase.mul(speed.mul(0.35));
    const amp = float(0.016)
      .add(tension.mul(0.03))
      .add(pulse.mul(0.06))
      .add(kineticEnergy.mul(0.018));

    // Delayed inner mass bends the membrane differently at opposite poles.
    // The shell begins settling before this term does, creating visible viscosity.
    const sloshWarp = vec3(
      slosh.x.mul(pt.y.mul(1.25).add(sin(animationPhase.mul(0.72)).mul(0.22))),
      slosh.y.mul(pt.x.mul(-1.1).add(cos(animationPhase.mul(0.61)).mul(0.2))),
      slosh.z.mul(pt.x.add(pt.y).mul(0.55)),
    ).mul(0.34);
    const jellyPt = pt.add(sloshWarp);

    // Multiple slow breathing frequencies keep the volume from inflating uniformly.
    const breathe = sin(t.mul(0.9))
      .mul(0.025)
      .mul(tension)
      .add(sin(animationPhase.mul(0.13)).mul(0.02))
      .add(sin(animationPhase.mul(0.31).add(jellyPt.y.mul(2.2))).mul(0.009));

    // multi-octave domain warp — slow primary swell + finer secondary shimmer
    const lean = vec3(pointer.x.mul(0.05), pointer.y.mul(-0.05), 0);
    const warpA = vec3(
      sin(jellyPt.y.mul(3.3).add(t).add(lean.x)).mul(amp),
      sin(jellyPt.z.mul(3.1).sub(t.mul(0.6))).mul(amp.mul(0.85)),
      sin(jellyPt.x.mul(3.6).add(t.mul(0.4)).add(lean.y)).mul(amp),
    );
    const warpB = vec3(
      sin(jellyPt.z.mul(6.2).sub(t.mul(1.1))).mul(amp.mul(0.26)),
      sin(jellyPt.x.mul(5.8).add(t.mul(0.8))).mul(amp.mul(0.26)),
      sin(jellyPt.y.mul(6.6).sub(t.mul(0.9))).mul(amp.mul(0.26)),
    );
    const collapseWarp = vec3(
      sin(jellyPt.x.mul(8.2).add(animationPhase.mul(2.4))).mul(collapseDistort.mul(0.075)),
      sin(jellyPt.y.mul(7.6).sub(animationPhase.mul(2.1))).mul(collapseDistort.mul(0.065)),
      sin(jellyPt.z.mul(9.1).add(animationPhase.mul(1.8))).mul(collapseDistort.mul(0.07)),
    );
    const fringeWarp = sin(jellyPt.x.mul(14).add(jellyPt.z.mul(11)).add(animationPhase.mul(0.9)))
      .mul(fringeRipple.mul(0.04));
    const q = jellyPt.add(warpA).add(warpB).add(collapseWarp).add(vec3(fringeWarp, fringeWarp.mul(0.6), fringeWarp.mul(-0.4)));

    // One continuous body. The previous twin-torus union cut large cavities
    // through the orb and made it read as a glass knot. Low, broad modes keep
    // this volume alive while the actual silhouette is owned by the solver.
    const morph = sin(animationPhase.mul(0.05)).mul(0.5).add(0.5);
    const broadMode = sin(q.x.mul(2.2).add(animationPhase.mul(0.12)))
      .mul(sin(q.y.mul(1.8).sub(animationPhase.mul(0.09))))
      .mul(float(0.006).add(kineticEnergy.mul(0.004)));
    const radius = float(0.525)
      .add(morph.mul(0.008))
      .add(breathe)
      .add(pulse.mul(0.028))
      .add(broadMode);
    const core = length(q).sub(radius);

    // twin travelling ripples crawling over the membrane (interference).
    // Kept gentle so the surface reads as sleek wet glass, not corrugated —
    // the concentric radial component especially must stay subtle.
    const r1 = sin(length(pt.xz).mul(9).sub(t.mul(2.2))).mul(sin(pt.y.mul(7).add(t))).mul(amp.mul(0.15));
    const r2 = sin(length(pt.yz).mul(6).add(t.mul(1.4))).mul(sin(pt.x.mul(5).sub(t.mul(0.7)))).mul(amp.mul(0.1));

    const surfaceQuiver = sin(q.x.mul(3.1).add(animationPhase.mul(0.58)))
      .mul(sin(q.y.mul(2.7).sub(animationPhase.mul(0.47))))
      .mul(float(0.006).add(abs(squash).mul(0.016)));
    const gelatinSwell = sin(q.y.mul(2.15).add(animationPhase.mul(0.46)))
      .add(sin(q.x.mul(1.8).sub(animationPhase.mul(0.37))))
      .mul(0.005);

    // fluid memory: four touch-ripples superposed as real SDF displacement
    // (not a shading trick) — the surface actually bulges where rings cross.
    // Length-guarded direction: rays through the orb center would hit
    // normalize(0)=NaN and poison the whole pixel (same guard as the
    // gradient normalize). Amplitude 0.03 keeps the added SDF gradient
    // (~12·0.03 per ring) inside what the sphere-trace already tolerates
    // from the domain warps — 0.05 caused overstep risk at crossing fronts.
    const rippleDir = p.div(max(length(p), float(1e-4)));
    const rippleDisplacement = ripple.rippleSum(rippleDir).mul(0.034);
    const contactDistance = acos(
      max(float(-1), min(float(1), dot(rippleDir, contactOrigin))),
    );
    const contactDimple = exp(contactDistance.mul(contactDistance).mul(-18))
      .mul(contactPressure)
      .mul(0.075);
    const secondaryContactDistance = acos(
      max(float(-1), min(float(1), dot(rippleDir, secondaryContactOrigin))),
    );
    const secondaryContactDimple = exp(
      secondaryContactDistance.mul(secondaryContactDistance).mul(-18),
    )
      .mul(secondaryContactPressure)
      .mul(0.075);

    return core
      .sub(r1)
      .sub(r2)
      .sub(surfaceQuiver)
      .sub(gelatinSwell)
      .sub(pulse.mul(0.05))
      .sub(rippleDisplacement)
      .add(contactDimple)
      .add(secondaryContactDimple);
  };

  const raymarch = Fn(() => {
    // True per-pixel view ray, reconstructed exactly as RaymarchingBox builds it:
    // the camera position transformed into object space, pointing at this
    // fragment. Using a constant (0,0,-1) made every view-dependent term
    // (fresnel, refraction, reflection, specular) correct ONLY dead-centre and
    // wrong toward the rim — the orb read as a flat stepped blob. This single
    // line is what makes the whole sphere behave like glass.
    const vOrigin = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0)).xyz;
    const rd = normalize(positionGeometry.sub(vOrigin)).toVar();
    const finalColor = vec4(0, 0, 0, 0).toVar(); // transparent void

    // Screen-pixel-stable hash decorrelates both fixed-step marches without
    // introducing temporal shimmer. The outer offset stays within a quarter
    // step, which breaks up low-tier contours without increasing loop count.
    const pixel = floor(screenUV.mul(screenSize));
    const hash = fract(
      sin(pixel.x.mul(127.31).add(pixel.y.mul(311.7)))
        .mul(43758.5453),
    ).toVar();
    const marchJitter = hash.sub(0.5).mul(float(0.5).div(stepCount));

    RaymarchingBox(stepCount, ({ positionRay }) => {
      const p = positionRay.add(rd.mul(marchJitter)).mul(2.6);
      const d = map(p as ReturnType<typeof vec3>);

      If(d.lessThan(0.0015), () => {
        const e = float(0.0012);
        const grad = vec3(
          map(p.add(vec3(e, 0, 0)) as ReturnType<typeof vec3>).sub(map(p.sub(vec3(e, 0, 0)) as ReturnType<typeof vec3>)),
          map(p.add(vec3(0, e, 0)) as ReturnType<typeof vec3>).sub(map(p.sub(vec3(0, e, 0)) as ReturnType<typeof vec3>)),
          map(p.add(vec3(0, 0, e)) as ReturnType<typeof vec3>).sub(map(p.sub(vec3(0, 0, e)) as ReturnType<typeof vec3>)),
        );
        // Length-guarded normalize: at the core the central-difference gradient
        // can collapse to ~0 → normalize(0)=NaN that poisons the whole pixel.
        const n = grad.div(max(length(grad), float(1e-5))).toVar();

        // Wavelet wet skin: a screen-stable tangent frame (with pole guard)
        // carries a detail-normal so light dances across a rippling water
        // surface. The raymarch has no derivatives, so we build the basis here.
        const upRef = mix(vec3(0, 1, 0), vec3(1, 0, 0), step(0.95, abs(n.y)));
        const tangent = normalize(cross(upRef, n)).toVar();
        const bitan = normalize(cross(n, tangent)).toVar();

        // three Gerstner-style wavelet layers → a height gradient (dU, dV).
        // Snapshot phase is pre-scaled for reduced motion and then modulated by
        // energy speed, so every autonomous surface wave follows one clock.
        const W = float(0.009)
          .add(tension.mul(0.006))
          .add(kineticEnergy.mul(0.004));
        const wt = animationPhase.mul(speed.mul(0.9));
        const uu = dot(p, tangent);
        const vv = dot(p, bitan);
        // incommensurate, non-grid wave directions so the ripple reads as
        // organic water rather than a regular checkerboard up close.
        const aA = uu.mul(7.31).add(vv.mul(2.69)).add(wt.mul(1.7));
        const aB = uu.mul(-5.13).add(vv.mul(8.61)).sub(wt.mul(1.3));
        const aC = uu.mul(12.73).add(vv.mul(9.41)).add(wt.mul(2.6));
        const dU = cos(aA)
          .mul(3.5)
          .add(cos(aB).mul(-1.6))
          .add(cos(aC).mul(2.34))
          .mul(W);
        const dV = cos(aA)
          .mul(1.5)
          .add(cos(aB).mul(2.88))
          .add(cos(aC).mul(1.8))
          .mul(W);
        // wet detail-normal — used ONLY for the lit terms. The geometric n is
        // kept for ndv / rim / refraction so the silhouette stays clean.
        const nW = normalize(n.sub(tangent.mul(dU)).sub(bitan.mul(dV))).toVar();

        const lightDir = normalize(vec3(-0.42, 0.72, 0.55));
        const fillDir = normalize(vec3(0.68, -0.18, 0.72));
        // Strongly wrapped, high-ambient lighting: a translucent water orb is
        // lit more by scattered ambient than by a hard key, so it glows evenly
        // with only a gentle directional gradient. This keeps any hemisphere
        // from crushing to black (no hard terminator for the march to stair-step).
        const diff = dot(nW, lightDir).mul(0.5).add(0.5).mul(0.34).add(0.26);
        const fill = dot(nW, fillDir).mul(0.5).add(0.5).mul(0.16);
        const ndv = max(dot(n, rd.negate()), 0).toVar();
        const fresnel = pow(float(1).sub(ndv), 1.7).toVar();

        // Straight-through path length Beer-Lambert needs. For a sphere the
        // chord ∝ ndv (≈1 at centre, 0 at the rim). Deriving it from ndv (the
        // smooth normal) rather than the depth-quantized hit position is what
        // avoids concentric march-step contour banding in the absorption.
        const thickness = smoothstep(0.0, 1.0, ndv).mul(0.98).toVar();

        // Snell-refract the view ray (IOR 1.33) so the interior is sampled along
        // the bent ray → true lens parallax. step() guards total-internal-
        // reflection (refract returns 0) against normalize(0)=NaN on WebGL2.
        const eta = float(0.752);
        const rr = refract(rd, n, eta);
        const rrLen = length(rr);
        const refrDir = normalize(
          mix(rd, rr.add(vec3(0, 0, -0.0001)), step(0.001, rrLen)),
        ).toVar();
        const refl = reflect(rd, n).toVar();

        // Chromatic dispersion: real glass bends blue more than red (higher
        // IOR). Three etas → three refraction directions. The green ray
        // above still drives the expensive interior march (cost stays flat —
        // no tripling the 10-step loop); R/B divergence FROM it becomes a
        // real per-channel absorption depth below, so the deep body itself
        // separates color toward the rim, not just a thin dispersive ring.
        const dispSpread = float(0.026);
        const etaR = eta.sub(dispSpread);
        const etaB = eta.add(dispSpread);
        const rrR = refract(rd, n, etaR);
        const rrB = refract(rd, n, etaB);
        const refrDirR = normalize(
          mix(rd, rrR.add(vec3(0, 0, -0.0001)), step(0.001, length(rrR))),
        ).toVar();
        const refrDirB = normalize(
          mix(rd, rrB.add(vec3(0, 0, -0.0001)), step(0.001, length(rrB))),
        ).toVar();
        // unsigned divergence from the primary ray — ~0 head-on (all etas
        // converge dead-center), growing toward the grazing silhouette where
        // Snell's law bends each wavelength apart the most.
        const dispMagR = length(refrDirR.sub(refrDir)).toVar();
        const dispMagB = length(refrDirB.sub(refrDir)).toVar();

        // Fresnel-Schlick (F0 = 0.02, water) + a small 3-probe procedural
        // environment sampled by the reflected ray → mirror-bright wet rim and a
        // moving sun-glint sweep, while the centre stays clear deep water.
        const sun = normalize(vec3(-0.35, 0.62, -0.7));
        const sky = normalize(vec3(0.2, 0.9, -0.3));
        const rim2 = normalize(vec3(0.7, -0.1, -0.6));
        const env = min(
          pow(max(dot(refl, sun), 0), 90.0)
            .mul(1.0)
            .add(pow(max(dot(refl, sky), 0), 8.0).mul(0.25))
            .add(pow(max(dot(refl, rim2), 0), 26.0).mul(0.18)),
          float(3.0),
        ).toVar();
        // ambient reflection floor → the grazing rim always reflects a faint
        // sky instead of going black where no probe happens to align.
        // Procedural sky: give the mirror rim a PLACE to reflect instead of
        // a flat constant — a graded world (deep void below, luminous zenith
        // above, a thin bright horizon band between). Continuous over the
        // whole reflection sphere, so the rim reflection slides believably
        // as the orb tumbles; this is most of what separates "real glass"
        // from "shaded ball". A few ALU on top of the existing probes.
        const upness = refl.y.mul(0.5).add(0.5);
        const skyGrad = mix(
          tint.mul(0.35),
          mix(accent, highlight, 0.24),
          pow(upness, 1.6),
        );
        const horizonBand = accent.mul(exp(abs(refl.y).mul(-5.5)).mul(0.5));
        const envCol = highlight
          .mul(env)
          .add(accent.mul(pow(max(dot(refl, sky), 0), 6.0).mul(0.12)))
          // graded ambient floor → the reflective rim catches the sky
          // instead of mirroring the empty black void as a dark crescent.
          .add(skyGrad.add(horizonBand).mul(0.52));
        // Schlick, but capped so the body always shows through the rim (a fully
        // mirror rim against an empty environment reads as a black crescent).
        const F0 = float(0.02);
        const fres = F0.add(float(1).sub(F0).mul(pow(float(1).sub(ndv), 5.0)))
          .mul(0.7)
          .toVar();

        // Zoned frosted glassmorphism rim: clear/refractive across the belly,
        // milky-frosted only at the grazing silhouette (how real frosted-glass
        // spheres behave). milkRim is gated by diff so dark back-rims stay black.
        const grazeMask = smoothstep(0.05, 0.55, ndv).oneMinus().toVar();
        // Lower-frequency frost so the grazing rim reads as soft frosted glass
        // instead of a buzzing high-frequency moiré (the product of two fast
        // sines over the normal aliased hard on curved silhouettes).
        const frostN = sin(n.x.mul(13.0).add(animationPhase.mul(0.4)))
          .mul(sin(n.y.mul(11.5).sub(animationPhase.mul(0.3))))
          .mul(0.5)
          .add(0.5);
        // Thin-film interference: a soap-bubble/beetle-shell shimmer at the
        // grazing rim. Real thin films shift hue with both the coating
        // thickness and the viewing angle — here the "thickness" breathes
        // slowly over time and varies across the surface (dot with an
        // arbitrary axis), and the angle term comes from the fresnel falloff
        // already in hand. (u,v) trace a circle inscribed in the unit square
        // as filmPhase advances, walking smoothly through all four corner
        // colors in a loop — cheap (pure mix/cos/sin, no branching) and it
        // shimmers as the orb turns because the object-space normal a given
        // screen pixel samples changes every frame.
        const filmThickness = float(1.0)
          .add(sin(animationPhase.mul(0.09)).mul(0.4))
          .add(dot(n, vec3(0.4, 0.7, 0.3)).mul(0.6))
          .add(resonance.mul(0.18))
          .add(pulse.mul(0.32))
          .add(kineticEnergy.mul(0.28));
        const filmPhase = filmThickness
          .mul(2.2)
          .add(pow(float(1).sub(ndv), 1.1).mul(4.4));
        const filmU = cos(filmPhase).mul(0.5).add(0.5);
        const filmV = sin(filmPhase).mul(0.5).add(0.5);
        // Cool quartet only — blue, cyan, violet, magenta. No warm stop, so
        // the sweep never drifts toward gold.
        const filmBlue = vec3(0.08, 0.32, 1.0);
        const filmCyan = vec3(0.08, 0.92, 1.0);
        const filmViolet = vec3(0.42, 0.14, 1.0);
        const filmMagenta = vec3(0.68, 0.1, 1.0);
        const filmColor = mix(
          mix(filmBlue, filmCyan, filmU),
          mix(filmMagenta, filmViolet, filmU),
          filmV,
        );
        // fresnel is already 0 at center / 1 at the silhouette — the film
        // takes over increasingly toward the rim, leaving the belly (and the
        // existing tint/accent glass read) untouched.
        const iriCol = mix(
          mix(tint, accent, pow(float(1).sub(ndv), 1.5).mul(0.94)),
          filmColor,
          min(float(0.96), fresnel.mul(0.78).add(resonance.mul(0.04)).add(pulse.mul(0.08))),
        );
        const rimSoft = pow(float(1).sub(ndv), 3.0);
        const rim = iriCol
          .mul(rimSoft)
          .mul(float(0.42).add(diff.mul(1.15)).add(fill.mul(0.8)))
          .mul(float(0.85).add(abs(squash).mul(0.32)))
          .mul(mix(float(1.0), float(0.6).add(frostN.mul(0.5)), grazeMask));
        const milkRim = mix(accent, highlight, 0.32)
          .mul(grazeMask)
          .mul(grazeMask)
          .mul(0.1)
          .mul(float(0.4).add(diff.mul(0.8)));

        // Two wet highlights make the membrane feel curved rather than painted.
        // They ride the rippling detail-normal so the sheen dances like water.
        const half = normalize(lightDir.add(rd.negate()));
        const fillHalf = normalize(fillDir.add(rd.negate()));
        const spec = accent.mul(
          pow(max(dot(nW, half), 0), 118.0).mul(0.72),
        );
        const softSpec = accent.mul(
          pow(max(dot(nW, fillHalf), 0), 24.0)
            .mul(0.18)
            .mul(float(1).add(abs(squash).mul(0.7))),
        );
        const movingSheen = accent.mul(
          pow(
            max(
              dot(
                nW,
                normalize(
                  vec3(
                    sin(animationPhase.mul(0.17)).mul(0.18).sub(0.38),
                    cos(animationPhase.mul(0.13)).mul(0.12).add(0.68),
                    -0.62,
                  ),
                ),
              ),
              0,
            ),
            7.0,
          ).mul(0.09),
        );

        // Beer-Lambert colored absorption: light is absorbed through real mass,
        // so the deep centre saturates toward the palette body colour while the
        // thin limbs glow clear. The restrained coefficient leaves enough light
        // in the belly for ocean water rather than an empty black shell.
        // in the deep. This is the change that turns a lit shell into a volume.
        // Gentler absorption so light carries deep into the body → luminous,
        // translucent tropical water rather than an opaque marble.
        const absorb = vec3(1.0).sub(tint).mul(float(0.44).add(tension.mul(0.13)));
        // Dispersed thickness: red's shallower bend reads as a longer optical
        // path (more absorbed), blue's sharper bend as shorter (less
        // absorbed) — real chromatic separation in the transmitted body
        // color. Gain 7: dispMag peaks ~0.04 at grazing but thickness→0
        // there, so the product needs this much drive for the mid-band
        // cool-shift to survive bloom+ACES (at 1.8 the whole effect was a
        // ≤2% transmit delta — invisible). Floor guards keep thicknessB
        // positive even if a pathological normal spikes dispMag.
        const thicknessR = thickness.mul(float(1).add(dispMagR.mul(7)));
        const thicknessB = thickness.mul(max(float(0.5), float(1).sub(dispMagB.mul(7))));
        const transmit = vec3(
          exp(absorb.x.mul(thicknessR).negate()),
          exp(absorb.y.mul(thickness).negate()),
          exp(absorb.z.mul(thicknessB).negate()),
        ).toVar();
        const clearInterior = mix(accent, tint, smoothstep(0.0, 1.2, thickness));
        const deepBody = clearInterior
          .mul(transmit)
          .mul(float(0.88).add(diff.mul(0.5)).add(fill.mul(0.35)))
          .add(mix(tint, accent, 0.58).mul(0.26)) // color floor → core glows, never black
          .toVar();
        // subsurface scatter: a soft turquoise glow lit from within, peaking
        // through the mid-body and backlit limbs → tropical-water translucency
        // (this is what keeps it from reading as an opaque ceramic ball).
        const backlit = pow(max(dot(nW, lightDir.negate()), 0), 1.4).add(0.4);
        const sss = mix(accent, highlight, 0.2)
          .mul(smoothstep(0.04, 0.85, thickness).mul(transmit))
          .mul(backlit.mul(0.76))
          .toVar();

        // internal gyroid tension-lattice, seen through the translucent shell:
        // a short inward sub-march from the hit point accumulates the glowing web
        const latGlow = float(0).toVar();
        const causAccum = float(0).toVar();
        // jitter the march start by up to one step so the 10 discrete shells
        // land at different depths per pixel → the concentric stair-step rings
        // dissolve into fine noise the bloom + output dither smooth away.
        const lp = p.add(refrDir.mul(hash.mul(0.055))).toVar();
        // Soft wide veils tighten into a finer stress trace only as energy rises;
        // at rest, the interior remains liquid rather than diagrammatic.
        // Higher-frequency, narrower bands make the inner field read as a
        // suspended filament network instead of a few glowing hollow rings.
        const gscale = float(6.2).add(tension.mul(2.8)).add(order.mul(4.2));
        const bandWidth = mix(float(0.2), float(0.085), order);
        const gphase = vec3(
          animationPhase.mul(0.06),
          animationPhase.mul(-0.04),
          animationPhase.mul(0.05),
        )
          .add(slosh.mul(1.8));
        Loop(10, ({ i }) => {
          lp.addAssign(refrDir.mul(0.055)); // march along the refracted ray
          const g = gyroid(lp.mul(gscale).add(gphase) as ReturnType<typeof vec3>);
          const band = smoothstep(0.0, bandWidth, abs(g)).oneMinus();
          const falloff = float(1).sub(float(i).mul(0.085));
          latGlow.addAssign(band.mul(float(0.28).add(order.mul(0.1))).mul(falloff));
          // depth stack: a second, coarser gyroid octave (0.45× scale,
          // slower phase) weighted by a ramp that GROWS with march depth —
          // opposite of the fine web's falloff. The fine structure lives
          // near the surface, a larger structure looms from the deep, and
          // refraction parallax separates them as the orb turns → real
          // interior depth instead of one flat suspended pattern.
          const g2 = gyroid(
            lp.mul(gscale.mul(0.45)).add(gphase.mul(0.6)) as ReturnType<typeof vec3>,
          );
          const band2 = smoothstep(0.0, bandWidth.mul(1.15), abs(g2)).oneMinus();
          latGlow.addAssign(band2.mul(0.065).mul(float(i).mul(0.085)));
          // Resonance makes the submerged stress trace briefly resolve.
          const mem = band.mul(resonance.mul(0.55)).mul(falloff.mul(0.7));
          latGlow.addAssign(mem);
          // depth-stacked caustics: broad sweeping light bands at low,
          // incommensurate frequencies. Two crossed high-frequency sines make a
          // literal checkerboard — the golf-ball artifact — so keep these wide
          // and let their PRODUCT only gate where both swells overlap.
          const cA = sin(
            lp.x
              .mul(3.7)
              .add(lp.y.mul(1.4))
              .add(animationPhase.mul(0.52))
              .add(slosh.x.mul(5.0)),
          )
            .mul(0.5)
            .add(0.5);
          const cB = sin(
            lp.y
              .mul(2.9)
              .sub(lp.z.mul(1.7))
              .sub(animationPhase.mul(0.36))
              .add(slosh.y.mul(4.0)),
          )
            .mul(0.5)
            .add(0.5);
          causAccum.addAssign(
            smoothstep(0.45, 1.0, cA.mul(cB)).mul(0.12).mul(falloff),
          );
        });
        // Light shafts: caustics brighten when the refracted view ray looks
        // back toward the key light — the bands align into light streaming
        // THROUGH the body from one direction, instead of an isotropic
        // interior shimmer. 0.35 floor keeps off-axis caustics alive.
        const shaft = float(0.35).add(
          pow(max(dot(refrDir, lightDir), 0.0), 3.0).mul(0.65),
        );
        const caustic = min(causAccum, float(1.0))
          .mul(float(0.15).add(tension.mul(0.08)).add(kineticEnergy.mul(0.16)))
          .mul(float(0.55).add(fresnel.mul(0.45)))
          .mul(shaft);
        // A broad, low-frequency liquid veil keeps the belly alive between
        // sharp lattice filaments. It drifts with the delayed inner mass so
        // the orb reads as water carrying light, not a hollow neon shell.
        const veilA = sin(
          lp.x
            .mul(2.15)
            .add(lp.z.mul(1.35))
            .add(animationPhase.mul(0.22))
            .add(slosh.x.mul(2.2)),
        )
          .mul(0.5)
          .add(0.5);
        const veilB = sin(
          lp.y
            .mul(1.8)
            .sub(lp.x.mul(1.1))
            .sub(animationPhase.mul(0.17))
            .add(slosh.y.mul(1.8)),
        )
          .mul(0.5)
          .add(0.5);
        const liquidVeil = smoothstep(0.34, 0.82, veilA.mul(veilB))
          .mul(float(0.4).add(kineticEnergy.mul(0.24)))
          .mul(float(0.52).add(fresnel.mul(0.48)));
        const waterGlow = mix(tint, accent, 0.62)
          .mul(liquidVeil)
          .mul(float(1.02).add(tension.mul(0.44)));
        const interiorBloom = mix(tint, accent, 0.64)
          .mul(smoothstep(0.08, 0.94, thickness))
          .mul(float(0.13).add(tension.mul(0.12)).add(kineticEnergy.mul(0.13)));

        // A slower, denser inner mass gives the glass something to contain. The
        // tilted boundary is driven by the same delayed slosh as the silhouette,
        // so a pull reads as water finding a new level rather than a separate FX.
        const fluidAxis = normalize(
          vec3(
            slosh.x.mul(0.55).add(sin(animationPhase.mul(0.17)).mul(0.07)),
            float(0.88).add(cos(animationPhase.mul(0.13)).mul(0.06)),
            slosh.y.mul(0.45).add(sin(animationPhase.mul(0.11)).mul(0.05)),
          ),
        ).toVar();
        const liquidHeight = dot(lp, fluidAxis)
          .add(
            sin(
              lp.x
                .mul(4.1)
                .add(lp.z.mul(2.35))
                .add(animationPhase.mul(0.31))
                .add(slosh.x.mul(5.2)),
            ).mul(0.032),
          )
          .add(
            sin(
              lp.z
                .mul(5.4)
                .sub(lp.y.mul(1.65))
                .sub(animationPhase.mul(0.22))
                .add(slosh.y.mul(3.4)),
            ).mul(0.018),
          )
          .toVar();
        const liquidFill = float(1)
          .sub(smoothstep(float(-0.42), float(0.38), liquidHeight))
          .toVar();
        const currentA = sin(
          lp.x
            .mul(3.45)
            .add(lp.z.mul(2.1))
            .add(animationPhase.mul(0.34))
            .add(slosh.x.mul(4.6)),
        )
          .mul(0.5)
          .add(0.5);
        const currentB = sin(
          lp.y
            .mul(2.65)
            .sub(lp.x.mul(1.85))
            .sub(animationPhase.mul(0.27))
            .add(slosh.y.mul(4.2)),
        )
          .mul(0.5)
          .add(0.5);
        const liquidCurrent = currentA.mul(0.62).add(currentB.mul(0.38));
        const liquidDirection = lp.div(max(length(lp), float(1e-4))).toVar();
        const liquidSurfaceWave = sin(
          lp.x
            .mul(7.4)
            .sub(lp.z.mul(5.1))
            .add(animationPhase.mul(0.76))
            .add(slosh.x.mul(7.2)),
        )
          .mul(sin(
            lp.y
              .mul(5.8)
              .add(lp.z.mul(4.3))
              .sub(animationPhase.mul(0.53))
              .add(slosh.y.mul(5.8)),
          ))
          .mul(0.5)
          .add(0.5);
        const liquidSurfaceCaustic = smoothstep(0.58, 0.96, liquidSurfaceWave)
          .mul(liquidFill)
          .mul(float(0.035).add(kineticEnergy.mul(0.12)).add(contactPressure.mul(0.09)));
        const innerLiquid = mix(tint, accent, float(0.3).add(liquidCurrent.mul(0.24)))
          .mul(liquidFill)
          .mul(
            float(0.11)
              .add(thickness.mul(0.2))
              .add(kineticEnergy.mul(0.22))
              .add(contactPressure.mul(0.16)),
          );
        // A press concentrates a tiny amount of refracted light into the
        // submerged liquid. It follows the contact normals rather than the
        // screen, which makes two-finger squishes feel like pressure entering
        // a volume instead of a flat color flash.
        const contactFocus = min(
          pow(max(dot(liquidDirection, contactOrigin), 0), 15)
            .mul(contactPressure)
            .add(
              pow(max(dot(liquidDirection, secondaryContactOrigin), 0), 15).mul(
                secondaryContactPressure,
              ),
            ),
          float(1),
        );
        const pressureCaustic = mix(accent, squishColor, squishColorStrength.mul(0.72))
          .mul(contactFocus)
          .mul(float(0.08).add(kineticEnergy.mul(0.18)).add(resonance.mul(0.08)));
        const liquidPrism = mix(stretchColor, squishColor, liquidSurfaceWave)
          .add(twistColor.mul(twistColorStrength.mul(0.18)));
        const liquidSurfaceColor = mix(
          accent,
          liquidPrism,
          stretchColorStrength.mul(0.28).add(squishColorStrength.mul(0.32)),
        );
        const liquidSurfaceGlow = mix(liquidSurfaceColor, highlight, 0.16)
          .mul(liquidSurfaceCaustic)
          .mul(float(0.7).add(fresnel.mul(0.3)));
        const meniscus = exp(abs(liquidHeight).mul(-20)).mul(
          float(0.11)
            .add(kineticEnergy.mul(0.38))
            .add(contactPressure.mul(0.3))
            .add(resonance.mul(0.06)),
        );
        const meniscusGlow = mix(accent, highlight, 0.14).mul(meniscus);
        const displacedCore = lp.add(slosh.mul(0.5));
        const coreLight = mix(tint, accent, 0.48)
          .mul(exp(length(displacedCore).mul(-3.4)))
          .mul(float(0.115).add(kineticEnergy.mul(0.2)).add(resonance.mul(0.07)))
          .mul(float(0.35).add(thickness.mul(0.65)));
        // soft-cap the accumulated glow so the web reads as filaments instead
        // of flooding the body with a flat saturated fill at high tension
        const latSoft = min(latGlow, float(1.25));
        const latticeHue = mix(tint, accent, latSoft.mul(0.72).add(fresnel.mul(0.12)));
        const latticeCol = latticeHue
          .mul(latSoft.mul(latSoft).mul(0.92))
          .mul(lattice)
          .mul(float(0.95).add(tension.mul(0.45)))
          .add(resonance.mul(0.22).mul(latSoft)) // resonance memory brightens the remembered web
          // the same dispersion in the suspended web itself, so the fringing
          // near the rim reads as one continuous glass effect rather than
          // the shell doing one thing and the interior another. (1.2, not a
          // whisper: dispMag is ~0.01–0.04, so this lands as a few-percent
          // warm/cool split on the bright filaments — audit found 0.4
          // vanished entirely under the grade.)
          .add(vec3(dispMagR, 0, dispMagB.negate()).mul(latSoft).mul(1.2));

        // Fluid memory made visible: recompute the ripple field ONCE at the
        // hit point (the march already paid for the displacement per-step;
        // this shading term is at-hit only, live waves per pixel). Crests emit
        // light like lit water — without this the rings exist but read as a
        // faint dent; with it a click leaves a glowing wake and crossings
        // flare where two rings superpose. Bloom (threshold 0.92) lifts a
        // fresh crest into a soft flash for free.
        const rippleHitDir = p.div(max(length(p), float(1e-4)));
        const crest = abs(ripple.rippleSum(rippleHitDir)).toVar();
        // Spectral tension is tied to the same modes that alter the silhouette:
        // cyan follows elongated poles, violet pools under direct compression,
        // and a restrained orchid band appears only while the mass is twisting.
        // All three strengths are zero at rest, so this remains water, not a
        // constantly color-shifting toy.
        const stressAxis = normalize(jiggle.add(vec3(0, 0.0001, 0)));
        const poleMask = pow(abs(dot(nW, stressAxis)), 1.55);
        const stretchBand = sin(
          dot(p, stressAxis).mul(13).add(animationPhase.mul(1.45)),
        )
          .mul(0.5)
          .add(0.5);
        const stretchFilament = smoothstep(0.7, 0.96, stretchBand);
        const stretchMask = stretchColorStrength
          .mul(poleMask.mul(0.42).add(stretchFilament.mul(0.58)))
          .toVar();
        const primaryHitDistance = acos(
          max(float(-1), min(float(1), dot(rippleHitDir, contactOrigin))),
        );
        const secondaryHitDistance = acos(
          max(float(-1), min(float(1), dot(rippleHitDir, secondaryContactOrigin))),
        );
        const contactBloom = min(
          exp(primaryHitDistance.mul(primaryHitDistance).mul(-22))
            .mul(contactPressure)
            .add(
              exp(secondaryHitDistance.mul(secondaryHitDistance).mul(-22)).mul(
                secondaryContactPressure,
              ),
            ),
          float(1),
        );
        const squishMask = squishColorStrength
          .mul(contactBloom.mul(0.82).add(crest.mul(0.26)))
          .toVar();
        const twistBand = sin(
          p.x
            .mul(8.7)
            .sub(p.y.mul(6.1))
            .add(p.z.mul(4.3))
            .add(animationPhase.mul(1.1)),
        )
          .mul(0.5)
          .add(0.5);
        const twistMask = twistColorStrength
          .mul(twistBand.mul(0.55).add(crest.mul(0.2)).add(poleMask.mul(0.25)))
          .toVar();
        // A stressed membrane separates its wavelengths instead of merely
        // brightening. The flowing blend makes a long pull reveal cyan and
        // violet bands in the same body, while the pressure/twist terms stay
        // anchored to the actual contact and torsion signals.
        const stretchPrism = mix(
          stretchColor,
          squishColor,
          stretchBand.mul(0.6).add(twistColorStrength.mul(0.16)),
        );
        const spectralVeil = stretchPrism
          .mul(stretchMask.mul(0.34))
          .add(squishColor.mul(squishMask.mul(0.58)))
          .add(twistColor.mul(twistMask.mul(0.38)));
        const activeRippleColor = mix(
          squishColor,
          twistColor,
          min(twistColorStrength, float(0.65)),
        );
        const rippleGlow = mix(
          mix(accent, activeRippleColor, squishColorStrength.mul(0.78)),
          highlight,
          0.25,
        )
          .mul(crest)
          .mul(0.84);

        // Tight sun-glint that twinkles on wave crests (gated by a wavelet mask)
        // — sparkles like sun on water, additive on the light highlight colour.
        // Ripple crests boost the mask so remembered rings twinkle as they pass.
        const sparkMask = smoothstep(
          0.6,
          1.0,
          sin(uu.mul(18.3).add(wt.mul(3.3)))
            .mul(sin(vv.mul(15.1).sub(wt.mul(2.7))))
            .mul(0.5)
            .add(0.5),
        );
        const sunGlint = highlight.mul(
          pow(max(dot(nW, half), 0), 180.0)
            .mul(0.9)
            .mul(float(0.35).add(sparkMask.mul(0.65)))
            .mul(float(1).add(crest.mul(1.5))),
        );

        // Energy-conserving glass: Fresnel mixes the transmitted water body
        // against the reflected environment (mix, not add → highlights stay
        // tight). spec / sheen / sun-glint ride on top.
        const glass = mix(
          deepBody
            .add(sss)
            .add(latticeCol)
            .add(waterGlow)
            .add(innerLiquid)
            .add(liquidSurfaceGlow)
            .add(pressureCaustic)
            .add(meniscusGlow)
            .add(coreLight)
            .add(interiorBloom)
            .add(accent.mul(caustic))
            .add(spectralVeil)
            .add(rim)
            .add(milkRim),
          envCol,
          fres,
        ).toVar();
        // Dispersive fresnel rim-glow: a luminous meniscus at the silhouette
        // with a faint chromatic split (blue refracts most → spreads inward,
        // red stays pinned to the very edge). Keeps the orb reading as a glass
        // shell catching light rather than a sphere fading to black. Stays in
        // the cool palette, so the split is subtle, not a rainbow.
        const eInv = float(1).sub(ndv);
        const dispR = pow(eInv, 4.4);
        const dispG = pow(eInv, 3.6);
        const dispB = pow(eInv, 2.9);
        const spectralRim = mix(
          accent,
          stretchPrism,
          stretchColorStrength.mul(0.42).add(twistColorStrength.mul(0.1)),
        );
        const rimGlow = mix(spectralRim, highlight, fresnel)
          .mul(vec3(dispR, dispG, dispB))
          .mul(0.58);
        const col = glass
          .add(spec)
          .add(softSpec.mul(0.5))
          .add(movingSheen.mul(0.6))
          .add(sunGlint)
          .add(rimGlow)
          .add(rippleGlow)
          .add(spectralVeil.mul(0.46))
          .toVar();
        // Hue-preserving floor keeps overlaps inside the ocean palette; a
        // Reinhard soft-knee then compresses only the brights, so mids and the
        // pure-black void survive ACES + bloom untouched.
        const graded = max(col, vec3(0)).add(tint.mul(0.05));
        const rolled = graded
          .mul(vec3(1).div(vec3(1).add(graded.mul(0.55))))
          .mul(1.55)
          .toVar();

        // soften silhouette into true black void — reduced from 0.22 to 0.12 so the orb's
        // edge stays glassy-translucent against the lattice rather than crushing to black.
        const fog = smoothstep(float(0.18), float(1.2), length(p));
        const visible = mix(rolled, vec3(0), fog.mul(0.12)).mul(presence);
        // Higher body opacity floor: at 0.18 the body was ~80% transparent and
        // composited to nothing over the black void, leaving only the fresnel
        // RIM (origin/origin_core read as a hollow outline). 0.42 makes the lit
        // body read as a filled luminous seed while staying translucent glass.
        const finalAlpha = mix(float(0.42).add(tension.mul(0.12)), float(0.94), fres).mul(presence).toVar();
        finalColor.assign(vec4(visible, finalAlpha));
        Break();
      });
    });

    finalColor.a.lessThan(0.01).discard();
    return finalColor;
  });

  const material = new NodeMaterial();
  material.colorNode = raymarch();
  material.transparent = true;
  // FrontSide: the camera is outside the bounding box, so only the near faces
  // need to launch rays. DoubleSide double-composited the back faces — with the
  // true per-pixel view ray that produced a hard vertical seam — and doubled the
  // cost of the scene's heaviest shader for zero gain.
  material.side = FrontSide;
  material.depthWrite = false;
  material.depthTest = false;

  return {
    material,
    tension,
    order,
    speed,
    phase,
    motionScale,
    pulse,
    tint,
    accent,
    highlight,
    stretchColor,
    squishColor,
    twistColor,
    stretchColorStrength,
    squishColorStrength,
    twistColorStrength,
    lattice,
    resonance,
    presence,
    collapseDistort,
    fringeRipple,
    pointer,
    jiggle,
    squash,
    bend,
    slosh,
    kineticEnergy,
    contactOrigin,
    contactPressure,
    secondaryContactOrigin,
    secondaryContactPressure,
    stepCount,
    ripple,
  };
}
