/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck — TSL node DSL: runtime-correct, but its operator types can't be
// modeled by TypeScript. Same rationale as jellyOrbMaterial.ts, which this was
// extracted from. App code outside the shaders stays fully type-checked.
import { Vector4 } from 'three';
import { Fn, Loop, acos, dot, exp, float, int, max, min, sin, sqrt, uniform, uniformArray, vec3 } from 'three/tsl';

/** Ring-buffer depth. Must match WAVE_COUNT in organismController.ts. */
export const RIPPLE_SLOTS = 8;

// Dispersion tuning. K_MAX is a march-safety bound as much as a look choice:
// SDF gradient rises with wavenumber, and the orb oversteps into black speckles
// before it looks wrong in any subtler way.
const K_BASE = 14;
const DISPERSION_GAIN = 3.0;
const K_MIN = 5.0;
const K_MAX = 16.0;
const ENVELOPE = 12;
/** The pre-dispersion wavenumber. Amplitude is normalized back to this so the
 * SDF gradient never exceeds what the sphere-trace already tolerated. */
const K_REFERENCE = 10.5;

/**
 * Fluid memory: the last touches, still crossing the membrane as travelling
 * wavefronts that genuinely superpose.
 *
 * The CPU compacts live waves to the front of the buffer and publishes how many
 * there are, so this loop runs exactly `liveCount` times. That matters more than
 * it looks: this sum is evaluated inside the SDF, once per march step (128 at the
 * high tier), so a dead slot is not free — it costs a full acos + exp + sin per
 * step per pixel. The previous four-slot unroll paid all four unconditionally,
 * which meant an untouched orb spent ~512 transcendentals per pixel per frame
 * rendering nothing. At rest this now costs zero.
 */
export function createRippleField() {
  // xyz = surface origin (unit), w = strength.
  const slots = Array.from({ length: RIPPLE_SLOTS }, () => new Vector4(0, 0, 1, 0));
  const ages = Array.from({ length: RIPPLE_SLOTS }, () => 0);
  const waveArray = uniformArray<'vec4'>(slots, 'vec4');
  const ageArray = uniformArray<'float'>(ages, 'float');
  // @types/three has no "int" overload for uniform(), so the count is held as a
  // float and converted with int() at the point of use.
  const liveCount = uniform(0);

  /**
   * One travelling wavefront: an expanding ring (front = age * speed) that fades
   * with age and with distance from the current front, so it reads as a ring
   * crossing the surface rather than a ripple filling the whole orb at once.
   *
   * The packet is dispersive. Real capillary waves separate by wavelength — short
   * ones outrun long ones — so a single impact spreads into a chirp rather than
   * holding one clean ring forever. Varying the wavenumber across the packet
   * compresses the wavelength ahead of the front and stretches it behind. This is
   * a stationary-phase approximation shaped like real dispersion, not a solve of
   * the capillary dispersion relation.
   */
  const rippleWave = (dir, origin, age, strength) => {
    // Great-circle distance makes a wave travel around the membrane at a
    // constant angular speed instead of accelerating across the far side.
    const dist = acos(max(float(-1), min(float(1), dot(dir, origin))));
    // A wave needs enough travel time to reach the far hemisphere before its
    // controller-side memory expires, otherwise a release reads as a local flash.
    const front = age.mul(0.78);
    const delta = dist.sub(front);
    // The envelope has to be wide enough to hold several crests or the chirp is
    // invisible. At the previous 34 the packet was sigma ~= 0.12 rad against a
    // 0.60 rad wavelength — about one fifth of a single wave, so a "ripple" was
    // really one crest and dispersion had nothing to act on. 12 gives ~0.20 rad.
    const envelope = exp(age.mul(0.3).add(delta.mul(delta).mul(ENVELOPE)).negate());
    const k = max(K_MIN, min(K_MAX, float(K_BASE).add(delta.mul(DISPERSION_GAIN))));
    const wave = sin(dist.mul(k).sub(age.mul(3.0)));
    // Amplitude is normalized against the EFFECTIVE wavenumber, not k.
    // Two things bite here, and missing either punches black speckles through
    // the orb on the low tier (48 march steps, far less gradient headroom
    // than high's 128):
    //   1. k itself varies with dist, so d/ddist[sin(dist*k(delta))] carries an
    //      extra dist*DISPERSION_GAIN term beyond k — the chirp steepens the
    //      surface more than its nominal wavenumber suggests.
    //   2. The reference is the ORIGINAL 10.5, not K_BASE. Normalizing to
    //      K_BASE=14 would still leave the gradient 1.33x what the sphere-trace
    //      was tuned against.
    // max() keeps this purely attenuating, so it can never amplify a shallow
    // wave into a steep one.
    const kEffective = max(float(K_REFERENCE), k.add(dist.mul(DISPERSION_GAIN)));
    return wave.mul(envelope).mul(strength).mul(float(K_REFERENCE).div(kEffective));
  };

  /**
   * Summed displacement from every live wave, in SDF units.
   *
   * Incoherent superposition of N waves grows as sqrt(N), so the sum is scaled by
   * min(1, 2/sqrt(N)): exactly 1.0 for 1-4 waves (preserving the previous look
   * bit-for-bit at the old capacity) and 0.707 at 8. This is what keeps the added
   * SDF gradient inside what the sphere-trace tolerates — overstep here shows up
   * as black speckles punched through the orb, not as a subtle artifact.
   */
  // MUST be a real TSL function, not a plain JS helper. `.toVar()` and `Loop()`
  // emit statements, and this is called from inside `map()` — which the raymarch
  // invokes per march step and again for the central-difference SDF normal. As a
  // JS helper those statements land in one scope while the value is read from
  // others, so `total` is read outside the loop that fills it: at liveCount 0 the
  // SDF went negative everywhere and the orb rendered as a full-screen flat fill.
  // Fn() gives the body its own scope and turns every call site into a real
  // function call. setLayout keeps it explicit for both the GLSL and WGSL backends.
  const rippleSum = Fn(([dir]) => {
    const total = float(0).toVar();
    Loop({ start: 0, end: int(liveCount), type: 'int' }, ({ i }) => {
      const slot = waveArray.element(i);
      total.addAssign(
        rippleWave(dir, vec3(slot.x, slot.y, slot.z), ageArray.element(i), slot.w),
      );
    });
    const normalization = min(float(1), float(2).div(sqrt(max(float(1), liveCount))));
    return total.mul(normalization);
  }).setLayout({
    name: 'aestherRippleSum',
    type: 'float',
    inputs: [{ name: 'dir', type: 'vec3' }],
  });

  return { slots, ages, waveArray, ageArray, liveCount, rippleSum };
}
