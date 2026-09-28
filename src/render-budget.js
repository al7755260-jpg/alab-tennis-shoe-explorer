// Hysteresis avoids reallocating the drawing buffer on every fluctuating frame.
// The DOM overlay always retains native resolution; original mesh assets are unchanged.
export function createRenderBudget(renderer, deviceRatio = 1) {
  let width = 1, height = 1, tier = 0, sampleCount = 0, slowFrames = 0;
  let lastChange = -Infinity, wasContinuous = false, idleSince = null, motionUntil = -Infinity;
  const scales = [1, .82, .67];
  function resetSamples() { sampleCount = 0; slowFrames = 0; }
  function detailRatio() { return Math.min(deviceRatio, 1, Math.sqrt(1200000 / (width * height))); }
  return {
    resize(w, h) { width = w; height = h; resetSamples(); },
    update(now, delta, moving, continuous) {
      if (continuous && wasContinuous && delta > 0 && delta < 200) {
        sampleCount++; if (delta > 23) slowFrames++;
        if (sampleCount >= 45) {
          if (slowFrames / sampleCount > .28 && tier < 2 && now - lastChange > 1800) {
            tier++; lastChange = now;
          }
          resetSamples();
        }
      } else if (!continuous) resetSamples();
      wasContinuous = continuous;
      if (moving) motionUntil = now + 500;
      // Full still-frame detail returns once the whole scene is at rest. Remember
      // the learned continuous budget so the next gesture doesn't stall again.
      if (continuous) idleSince = null;
      else if (idleSince === null) idleSince = now;
      const scale = !continuous && now - idleSince >= 500 ? 1 : Math.min(now < motionUntil ? .85 : 1, scales[tier]);
      const ratio = Math.round(detailRatio() * scale * 100) / 100;
      if (Math.abs(renderer.getPixelRatio() - ratio) < .009) return false;
      renderer.setPixelRatio(ratio);
      return true;
    },
    get tier() { return tier; },
  };
}
