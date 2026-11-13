function makeFilter(context, type, frequency, q) {
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.Q.value = q;
  if (frequency !== undefined) filter.frequency.value = frequency;
  return filter;
}

function createAdjustableEffect(context) {
  const input = context.createGain();
  const output = context.createGain();
  const dry = context.createGain();
  const wet = context.createGain();
  const lowpasses = Array.from({ length: 4 }, () => makeFilter(context, 'lowpass', undefined, 0.7));
  const highpass = makeFilter(context, 'highpass', undefined, 0.7);
  const notches = [800, 1500, 2500, 3500].map(frequency => makeFilter(context, 'notch', frequency, 2));
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -35;
  compressor.knee.value = 25;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.08;

  input.connect(dry);
  dry.connect(output);
  const chain = [input, highpass, ...lowpasses, ...notches, compressor, wet, output];
  for (let index = 1; index < chain.length; index++) chain[index - 1].connect(chain[index]);

  const delayTimes = [0.003, 0.005, 0.007, 0.010, 0.013, 0.016, 0.020, 0.024, 0.028, 0.033, 0.038, 0.044, 0.050, 0.057, 0.065];
  const delayGains = delayTimes.map(time => {
    const delay = context.createDelay(0.1);
    const gain = context.createGain();
    delay.delayTime.value = time;
    compressor.connect(delay);
    delay.connect(gain);
    gain.connect(output);
    return gain;
  });

  return { input, output, dry, wet, lowpasses, highpass, notches, compressor, delayGains };
}

function applyEffectIntensity(effect, intensity, context, immediate = false) {
  const now = context.currentTime;
  const setGain = (node, value) => {
    if (immediate) node.gain.setValueAtTime(value, now);
    else node.gain.setTargetAtTime(value, now, 0.01);
  };

  const strength = intensity < 0.05 ? 0 : Math.pow(intensity, 0.55);
  const lowpassRanges = [[6000, 5700], [4000, 3800], [2500, 2300], [1500, 1300]];
  effect.lowpasses.forEach((filter, index) => {
    const [base, range] = lowpassRanges[index];
    filter.frequency.value = base - strength * range;
  });
  effect.highpass.frequency.value = 150 + strength * 600;
  for (const notch of effect.notches) notch.Q.value = 2 + strength * 5;
  effect.compressor.ratio.value = Math.min(20, 12 + strength * 18);
  effect.delayGains.forEach((gain, index) => setGain(gain, 0.35 * strength / (index + 1)));
  setGain(effect.dry, Math.max(0, 1 - strength * 1.1));
  setGain(effect.wet, strength * 1.2);
}
