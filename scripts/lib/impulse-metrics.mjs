import {
  detectOnset,
  energy,
  fractionalOctaveBands,
  peakIndex,
} from "./acoustics.mjs";

const powerDb = (power) => power > 0 ? 10 * Math.log10(power) : Number.NEGATIVE_INFINITY;

export function median(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return Number.NaN;
  const middle = finite.length >> 1;
  return finite.length & 1 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

export function stereoWindowEnergy(left, right, leftStart, rightStart, length) {
  return energy(left, leftStart, leftStart + length) + energy(right, rightStart, rightStart + length);
}

export function alignedStereoWindow(left, right, leftStart, rightStart, length) {
  const leftWindow = new Float64Array(length);
  const rightWindow = new Float64Array(length);
  for (let index = 0; index < length; index++) {
    leftWindow[index] = left[leftStart + index] ?? 0;
    rightWindow[index] = right[rightStart + index] ?? 0;
  }
  return { left: leftWindow, right: rightWindow };
}

export function stereoBandPowers(left, right, sampleRate, options = {}) {
  const fraction = options.fraction ?? 3;
  const fftSize = options.fftSize;
  const bandOptions = {
    minimumFrequency: options.minimumFrequency ?? 20,
    maximumFrequency: options.maximumFrequency ?? sampleRate / 2,
    ...(fftSize ? { fftSize } : {}),
  };
  const leftBands = fractionalOctaveBands(left, sampleRate, fraction, bandOptions);
  const rightBands = fractionalOctaveBands(right, sampleRate, fraction, bandOptions);
  return leftBands.map((leftBand, index) => ({
    centerHz: leftBand.center,
    lowHz: leftBand.low,
    highHz: leftBand.high,
    power: leftBand.power + rightBands[index].power,
    powerDb: powerDb(leftBand.power + rightBands[index].power),
  }));
}

export function sumBandPower(bands, minimumFrequency, maximumFrequency) {
  return bands.reduce((sum, band) => {
    return band.centerHz >= minimumFrequency && band.centerHz <= maximumFrequency ? sum + band.power : sum;
  }, 0);
}

export function analyzeStereoImpulse(left, right, sampleRate, options = {}) {
  const onsetOptions = {
    thresholdDb: options.onsetThresholdDb ?? -30,
    holdSamples: options.onsetHoldSamples ?? 1,
    end: Math.min(left.length, right.length, options.onsetSearchSamples ?? Math.round(sampleRate * 0.03)),
  };
  const leftOnset = detectOnset(left, onsetOptions);
  const rightOnset = detectOnset(right, onsetOptions);
  if (leftOnset === null || rightOnset === null) throw new Error("冲激响应中找不到双耳onset");

  const directMs = options.directWindowMs ?? 4;
  const earlyMs = options.earlyWindowMs ?? 50;
  const lateStartMs = options.lateStartMs ?? 50;
  const directSamples = Math.max(1, Math.round(directMs * sampleRate / 1000));
  const earlySamples = Math.max(directSamples, Math.round(earlyMs * sampleRate / 1000));
  const lateStartSamples = Math.max(directSamples, Math.round(lateStartMs * sampleRate / 1000));
  const direct = alignedStereoWindow(left, right, leftOnset, rightOnset, directSamples);
  const directBands = stereoBandPowers(direct.left, direct.right, sampleRate, {
    fraction: options.fraction ?? 3,
    fftSize: options.directFftSize ?? 4096,
  });
  const fullBands = stereoBandPowers(left, right, sampleRate, {
    fraction: options.fraction ?? 3,
    fftSize: options.fullFftSize,
  });

  const directEnergy = stereoWindowEnergy(left, right, leftOnset, rightOnset, directSamples);
  const earlyEnergy = stereoWindowEnergy(left, right, leftOnset, rightOnset, earlySamples);
  const lateEnergy = energy(left, leftOnset + lateStartSamples) + energy(right, rightOnset + lateStartSamples);
  const totalEnergy = energy(left, leftOnset) + energy(right, rightOnset);
  const leftPeak = peakIndex(left, leftOnset, Math.min(left.length, leftOnset + earlySamples));
  const rightPeak = peakIndex(right, rightOnset, Math.min(right.length, rightOnset + earlySamples));
  const c50Early = stereoWindowEnergy(left, right, leftOnset, rightOnset, Math.round(0.05 * sampleRate));
  const c80Early = stereoWindowEnergy(left, right, leftOnset, rightOnset, Math.round(0.08 * sampleRate));
  const c50Late = totalEnergy - c50Early;
  const c80Late = totalEnergy - c80Early;
  const referencePower = sumBandPower(
    directBands,
    options.referenceMinimumHz ?? 500,
    options.referenceMaximumHz ?? 2000,
  );

  return {
    onset: {
      leftSample: leftOnset,
      rightSample: rightOnset,
      commonSample: (leftOnset + rightOnset) / 2,
      itdSamples: leftOnset - rightOnset,
    },
    peak: {
      leftSample: leftPeak.index,
      rightSample: rightPeak.index,
      commonSample: (leftPeak.index + rightPeak.index) / 2,
      itdSamples: leftPeak.index - rightPeak.index,
      leftValue: leftPeak.value,
      rightValue: rightPeak.value,
    },
    windows: {
      directMs,
      earlyMs,
      lateStartMs,
      directEnergy,
      directEnergyDb: powerDb(directEnergy),
      earlyEnergy,
      earlyEnergyDb: powerDb(earlyEnergy),
      lateEnergy,
      lateEnergyDb: powerDb(lateEnergy),
      totalEnergy,
      totalEnergyDb: powerDb(totalEnergy),
      directToLateDb: powerDb(directEnergy / lateEnergy),
      c50Db: powerDb(c50Early / c50Late),
      c80Db: powerDb(c80Early / c80Late),
      referencePower,
      referencePowerDb: powerDb(referencePower),
    },
    directBands,
    fullBands,
  };
}
