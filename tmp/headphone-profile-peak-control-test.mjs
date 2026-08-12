// Profile peak-control diagnostic: a FIR-created peak is released locally
// before the shared final safety stage can hold down following core-band audio.
const PROFILE_PEAK_THRESHOLD_DB = -7;
const PROFILE_PEAK_RATIO = 12;
const PROFILE_RELEASE_MS = 40;
const FINAL_THRESHOLD_DB = -1;
const FINAL_RATIO = 4;
const FINAL_RELEASE_MS = 150;
const dbToGain = (db) => Math.pow(10, db / 20);
const gainToDb = (gain) => 20 * Math.log10(Math.max(gain, 1e-12));

function compressorGain(inputDb, thresholdDb, ratio) {
  if (inputDb <= thresholdDb) return 1;
  const outputDb = thresholdDb + (inputDb - thresholdDb) / ratio;
  return dbToGain(outputDb - inputDb);
}
function releasedGainReductionDb(initialReductionDb, elapsedMs, releaseMs) {
  return initialReductionDb * Math.exp(-elapsedMs / releaseMs);
}

let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}

// A 5.1kHz correction peak drives both paths; 80ms later, 1kHz program resumes.
const correctionPeakDb = 0;
const globalMakeupDb = 6;
const referenceDelayMs = 80;
const finalOnlyPeakGrDb = gainToDb(compressorGain(correctionPeakDb + globalMakeupDb, FINAL_THRESHOLD_DB, FINAL_RATIO));
const localPeakGrDb = gainToDb(compressorGain(correctionPeakDb, PROFILE_PEAK_THRESHOLD_DB, PROFILE_PEAK_RATIO));
const localPostPeakDb = correctionPeakDb + localPeakGrDb;
const finalAfterLocalPeakGrDb = gainToDb(compressorGain(localPostPeakDb + globalMakeupDb, FINAL_THRESHOLD_DB, FINAL_RATIO));
const finalOnlyRemainingDb = releasedGainReductionDb(finalOnlyPeakGrDb, referenceDelayMs, FINAL_RELEASE_MS);
const localRemainingDb = releasedGainReductionDb(localPeakGrDb, referenceDelayMs, PROFILE_RELEASE_MS);
const finalAfterLocalRemainingDb = releasedGainReductionDb(finalAfterLocalPeakGrDb, referenceDelayMs, FINAL_RELEASE_MS);
const localPathReferenceGainDb = localRemainingDb + finalAfterLocalRemainingDb;

check(localPeakGrDb < 0, "profile peak control 会在校正峰值到达共享 safety 前介入");
check(localPathReferenceGainDb > finalOnlyRemainingDb + 1,
  `80ms 后局部控制对主体参考的残余压低更小（${localPathReferenceGainDb.toFixed(2)} vs ${finalOnlyRemainingDb.toFixed(2)}dB）`);
console.log(`INFO  峰值时 local GR=${localPeakGrDb.toFixed(2)}dB，final-only GR=${finalOnlyPeakGrDb.toFixed(2)}dB；80ms 后 local+final 残余=${localPathReferenceGainDb.toFixed(2)}dB，final-only 残余=${finalOnlyRemainingDb.toFixed(2)}dB。`);

console.log(failed ? `\n${failed} 项失败` : "\nAirPods profile 峰值控制诊断通过");
process.exit(failed ? 1 : 0);
