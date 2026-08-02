import { useEffect } from "react";
import { useFrame } from "@react-three/fiber";
import { CameraRig } from "../experience/CameraRig";
import { useExperienceStore } from "../experience/store";
import { organismController } from "../simulation/organismController";
import { ContactSurface } from "./ContactSurface";
import { JellyOrb } from "./JellyOrb";
import { SpectralStressField } from "./SpectralStressField";

function OrganismDriver() {
  const reducedMotion = useExperienceStore((state) => state.reducedMotion);
  const tier = useExperienceStore((state) => state.profile?.tier ?? "high");

  useEffect(() => {
    organismController.setPresentationScale(
      tier === "low" ? 0.58 : tier === "medium" ? 0.76 : 0.82,
    );
  }, [tier]);

  useFrame((_, delta) => {
    organismController.advance(delta, reducedMotion);
  }, -10);

  return null;
}

export function AetherWorld() {
  return (
    <>
      <OrganismDriver />
      <CameraRig />
      <SpectralStressField />
      <JellyOrb />
      <ContactSurface />
    </>
  );
}
