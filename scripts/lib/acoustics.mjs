const TWO_PI = 2 * Math.PI;

export function nextPowerOfTwo(value) {
  let size = 1;
  while (size < value) size <<= 1;
  return size;
}

export function fftReal(input, size = nextPowerOfTwo(input.length)) {
  if (size < input.length || (size & (size - 1)) !== 0) {
    throw new Error("FFT size must be a power of two at least as long as input");
  }
  const real = new Float64Array(size);
  const imag = new Float64Array(size);
  real.set(input);

  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = -TWO_PI / length;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1;
      let twiddleImag = 0;
      for (let offset = 0; offset < length / 2; offset++) {
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal = real[odd] * twiddleReal - imag[odd] * twiddleImag;
        const oddImag = real[odd] * twiddleImag + imag[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imag[odd] = imag[even] - oddImag;
        real[even] += oddReal;
        imag[even] += oddImag;
        const nextReal = twiddleReal * stepReal - twiddleImag * stepImag;
        twiddleImag = twiddleReal * stepImag + twiddleImag * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
  return { real, imag };
}

export function powerSpectrum(input, size = nextPowerOfTwo(input.length)) {
  const { real, imag } = fftReal(input, size);
  const power = new Float64Array(size / 2 + 1);
  for (let bin = 0; bin < power.length; bin++) power[bin] = real[bin] ** 2 + imag[bin] ** 2;
  return power;
}

export function fractionalOctaveBands(input, sampleRate, fraction = 3, options = {}) {
  if (!Number.isInteger(fraction) || fraction <= 0) throw new Error("fraction must be a positive integer");
  const size = options.fftSize ?? nextPowerOfTwo(Math.max(input.length, 4096));
  const power = powerSpectrum(input, size);
  const minimum = options.minimumFrequency ?? 20;
  const maximum = Math.min(options.maximumFrequency ?? sampleRate / 2, sampleRate / 2);
  const reference = options.referenceFrequency ?? 1000;
  const ratio = 2 ** (1 / fraction);
  const halfRatio = 2 ** (1 / (2 * fraction));
  const firstIndex = Math.ceil(Math.log(minimum / reference) / Math.log(ratio));
  const lastIndex = Math.floor(Math.log(maximum / reference) / Math.log(ratio));
  const bands = [];

  for (let index = firstIndex; index <= lastIndex; index++) {
    const center = reference * ratio ** index;
    const low = center / halfRatio;
    const high = center * halfRatio;
    const firstBin = Math.max(1, Math.ceil(low * size / sampleRate));
    const lastBin = Math.min(power.length - 1, Math.floor(high * size / sampleRate));
    let sum = 0;
    for (let bin = firstBin; bin <= lastBin; bin++) sum += power[bin];
    bands.push({ center, low, high, power: sum });
  }
  return bands;
}

export function peakIndex(input, start = 0, end = input.length) {
  let index = Math.max(0, Math.trunc(start));
  let peak = 0;
  const stop = Math.min(input.length, Math.trunc(end));
  for (let i = index; i < stop; i++) {
    const value = Math.abs(input[i]);
    if (value > peak) {
      peak = value;
      index = i;
    }
  }
  return { index, value: peak };
}

export function detectOnset(input, options = {}) {
  const start = Math.max(0, Math.trunc(options.start ?? 0));
  const end = Math.min(input.length, Math.trunc(options.end ?? input.length));
  const thresholdDb = options.thresholdDb ?? -30;
  const holdSamples = Math.max(1, Math.trunc(options.holdSamples ?? 1));
  const peak = peakIndex(input, start, end).value;
  if (!(peak > 0)) return null;
  const threshold = peak * 10 ** (thresholdDb / 20);
  let held = 0;
  for (let i = start; i < end; i++) {
    if (Math.abs(input[i]) >= threshold) {
      held++;
      if (held >= holdSamples) return i - holdSamples + 1;
    } else {
      held = 0;
    }
  }
  return null;
}

export function energy(input, start = 0, end = input.length) {
  let sum = 0;
  const first = Math.max(0, Math.trunc(start));
  const stop = Math.min(input.length, Math.trunc(end));
  for (let i = first; i < stop; i++) sum += input[i] ** 2;
  return sum;
}

export function clarityDb(input, sampleRate, splitMs, onset = 0) {
  const split = Math.min(input.length, Math.max(onset, onset + Math.round(splitMs * sampleRate / 1000)));
  const early = energy(input, onset, split);
  const late = energy(input, split);
  if (late === 0) return early > 0 ? Number.POSITIVE_INFINITY : Number.NaN;
  return 10 * Math.log10(early / late);
}

function correlationAtLag(reference, signal, lag) {
  const start = Math.max(0, -lag);
  const end = Math.min(reference.length, signal.length - lag);
  let sum = 0;
  let referenceEnergy = 0;
  let signalEnergy = 0;
  for (let index = start; index < end; index++) {
    const a = reference[index];
    const b = signal[index + lag];
    sum += a * b;
    referenceEnergy += a * a;
    signalEnergy += b * b;
  }
  const denominator = Math.sqrt(referenceEnergy * signalEnergy);
  return denominator > 0 ? sum / denominator : 0;
}

export function estimateDelay(reference, signal, maxLag) {
  const limit = Math.max(0, Math.trunc(maxLag));
  const correlations = new Float64Array(limit * 2 + 1);
  let bestIndex = 0;
  let bestMagnitude = -1;
  for (let lag = -limit; lag <= limit; lag++) {
    const value = correlationAtLag(reference, signal, lag);
    const index = lag + limit;
    correlations[index] = value;
    if (Math.abs(value) > bestMagnitude) {
      bestMagnitude = Math.abs(value);
      bestIndex = index;
    }
  }

  let fractional = 0;
  if (bestIndex > 0 && bestIndex + 1 < correlations.length) {
    const left = Math.abs(correlations[bestIndex - 1]);
    const center = Math.abs(correlations[bestIndex]);
    const right = Math.abs(correlations[bestIndex + 1]);
    const denominator = left - 2 * center + right;
    if (Math.abs(denominator) > 1e-12) fractional = 0.5 * (left - right) / denominator;
  }
  return {
    lag: bestIndex - limit + Math.max(-0.5, Math.min(0.5, fractional)),
    correlation: correlations[bestIndex],
  };
}

export function unwrapPhase(phase) {
  const output = new Float64Array(phase.length);
  if (phase.length === 0) return output;
  output[0] = phase[0];
  let correction = 0;
  for (let index = 1; index < phase.length; index++) {
    const delta = phase[index] - phase[index - 1];
    if (delta > Math.PI) correction -= TWO_PI;
    else if (delta < -Math.PI) correction += TWO_PI;
    output[index] = phase[index] + correction;
  }
  return output;
}

export function groupDelay(input, sampleRate, size = nextPowerOfTwo(Math.max(input.length, 4096))) {
  const { real, imag } = fftReal(input, size);
  const phase = new Float64Array(size / 2 + 1);
  for (let bin = 0; bin < phase.length; bin++) phase[bin] = Math.atan2(imag[bin], real[bin]);
  const unwrapped = unwrapPhase(phase);
  const delaySeconds = new Float64Array(phase.length);
  const angularStep = TWO_PI * sampleRate / size;
  for (let bin = 1; bin + 1 < phase.length; bin++) {
    delaySeconds[bin] = -(unwrapped[bin + 1] - unwrapped[bin - 1]) / (2 * angularStep);
  }
  delaySeconds[0] = delaySeconds[1];
  delaySeconds[delaySeconds.length - 1] = delaySeconds[delaySeconds.length - 2];
  return delaySeconds;
}

export function stereoArrival(left, right, options = {}) {
  const leftOnset = detectOnset(left, options);
  const rightOnset = detectOnset(right, options);
  if (leftOnset === null || rightOnset === null) return null;
  return {
    left: leftOnset,
    right: rightOnset,
    common: (leftOnset + rightOnset) / 2,
    itd: leftOnset - rightOnset,
  };
}
