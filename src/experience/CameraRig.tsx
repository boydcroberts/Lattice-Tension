/* eslint-disable react-hooks/immutability -- R3F useFrame drives the live camera */
import { useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { PerspectiveCamera, Vector3 } from "three";
import { organismController } from "../simulation/organismController";
import { useExperienceStore } from "./store";

const LOOK_TARGET = new Vector3();

/** A quiet observer: motion responds to the organism rather than directing it. */
export function CameraRig() {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const initialized = useRef(false);

  useFrame((_, delta) => {
    const snapshot = organismController.snapshot;
    const { reducedMotion, profile } = useExperienceStore.getState();
    const lowTier = profile?.tier === "low";
    const motion = reducedMotion ? 0.1 : 1;
    const dt = Math.min(delta, 1 / 30);
    const blend = 1 - Math.exp(-4.2 * dt);

    const parallaxX = snapshot.dragging ? snapshot.pointer[0] * 0.018 : 0;
    const parallaxY = snapshot.dragging ? snapshot.pointer[1] * 0.013 : 0;
    const targetX = snapshot.position[0] * 0.16 + snapshot.slosh[0] * 0.018 + parallaxX;
    const targetY = snapshot.position[1] * 0.12 + snapshot.slosh[1] * 0.014 + parallaxY;
    // The camera yields a little space as the volume stretches, so a strong
    // pull never turns the organism into a cropped shape at the viewport edge.
    const deformation = Math.min(
      0.18,
      Math.abs(snapshot.strain) * 0.22 +
        Math.hypot(...snapshot.bend) * 0.055 +
        snapshot.contactPressure * 0.055 +
        Math.min(snapshot.energy, 1) * 0.035,
    );
    const targetZ = (lowTier ? 0.84 : 0.68) + deformation;
    const targetFov = lowTier ? 51 : 48;

    if (!initialized.current) {
      camera.position.set(targetX, targetY, targetZ);
      camera.fov = targetFov;
      initialized.current = true;
    } else {
      camera.position.x += (targetX - camera.position.x) * blend;
      camera.position.y += (targetY - camera.position.y) * blend;
      camera.position.z += (targetZ - camera.position.z) * blend;
    }
    camera.fov += (targetFov - camera.fov) * blend;
    camera.updateProjectionMatrix();

    LOOK_TARGET.set(
      snapshot.position[0] + snapshot.slosh[0] * 0.012,
      snapshot.position[1] + snapshot.slosh[1] * 0.01,
      0,
    );
    if (!reducedMotion) {
      LOOK_TARGET.x += Math.sin(snapshot.phase * 0.13) * 0.006 * motion;
      LOOK_TARGET.y += Math.cos(snapshot.phase * 0.11) * 0.005 * motion;
    }
    camera.lookAt(LOOK_TARGET);
  }, -4);

  return null;
}
