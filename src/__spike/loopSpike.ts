// DEV-ONLY SPIKE — not shipped, not imported by the app.
// Question: does TSL `Loop(<dynamic uniform count>)` over a `uniformArray`
// compile and run correctly on the *WebGL* backend (the app's default), when
// nested inside an outer loop the way the ripple sum sits inside the raymarch?
//
// Renders to a small render target and reads back exact pixel values for a
// series of liveCount values. If readback tracks liveCount, dynamic loops work.
import { Vector4, RenderTarget, Scene, OrthographicCamera, Mesh, PlaneGeometry } from "three";
import { WebGPURenderer, NodeMaterial } from "three/webgpu";
import { Fn, Loop, uniform, uniformArray, vec4, float, vec3, int } from "three/tsl";

type SpikeResult = {
  backend: string;
  outerLoopSteps: number;
  cases: { liveCount: number; expected: number; got: number; ok: boolean }[];
  allOk: boolean;
  error?: string;
};

const SLOTS = 8;
const OUTER_STEPS = 16; // stands in for raymarch steps

export async function runLoopSpike(): Promise<SpikeResult> {
  const result: SpikeResult = {
    backend: "unknown",
    outerLoopSteps: OUTER_STEPS,
    cases: [],
    allOk: false,
  };

  try {
    const renderer = new WebGPURenderer({ antialias: false, forceWebGL: true });
    await renderer.init();
    // `isWebGLBackend` is a real runtime flag but is not on the public `Backend`
    // type in @types/three 0.184.1, so the read is narrowed here deliberately.
    result.backend = (renderer.backend as unknown as { isWebGLBackend?: boolean })
      .isWebGLBackend
      ? "WebGL"
      : "WebGPU";

    // Slot i carries weight (i + 1). Summing the first N slots therefore gives
    // a known triangular number — an exact, unmistakable expected value.
    const slots = Array.from({ length: SLOTS }, (_, i) => new Vector4(i + 1, 0, 0, 0));
    const waveArray = uniformArray<"vec4">(slots, "vec4");
    // @types/three declares uniform() as (number, type?: "float") with no "int"
    // overload, so the count is held as a float uniform and converted with int()
    // at the point of use. Loop's object form takes Node<"int"> for `end`.
    const liveCount = uniform(0);

    // Sum the live slots, nested inside an outer fixed loop, mirroring how the
    // ripple sum will sit inside the march. Divide by OUTER_STEPS so the outer
    // loop does not change the value — it only proves nesting compiles.
    const shade = Fn(() => {
      const total = float(0).toVar();
      Loop(OUTER_STEPS, () => {
        Loop({ start: 0, end: int(liveCount), type: "int" }, ({ i }) => {
          total.addAssign(waveArray.element(i).x);
        });
      });
      // Normalize: max possible sum is 36 (1+2+...+8) * OUTER_STEPS.
      const norm = total.div(float(36 * OUTER_STEPS));
      return vec4(vec3(norm), 1);
    });

    const material = new NodeMaterial();
    material.fragmentNode = shade();

    const scene = new Scene();
    scene.add(new Mesh(new PlaneGeometry(2, 2), material));
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const target = new RenderTarget(4, 4);

    for (const n of [0, 1, 2, 4, 7, 8]) {
      liveCount.value = n;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);

      const buffer = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
      // triangular number: sum of first n slot weights
      const expected = (n * (n + 1)) / 2 / 36;
      const got = (buffer as Uint8Array)[0]! / 255;
      result.cases.push({
        liveCount: n,
        expected: +expected.toFixed(3),
        got: +got.toFixed(3),
        ok: Math.abs(got - expected) < 0.012, // 8-bit readback tolerance
      });
    }

    result.allOk = result.cases.every((c) => c.ok);
    renderer.dispose();
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

declare global {
  interface Window {
    __loopSpike?: SpikeResult;
  }
}

runLoopSpike().then((r) => {
  window.__loopSpike = r;
  console.log("SPIKE_RESULT " + JSON.stringify(r));
});
