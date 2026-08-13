import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

export const AZ_EL_PATTERNS = [
  /azi_(-?\d+),(\d+)_ele_(-?\d+),(\d+)/i,
  /az(-?\d+(?:\.\d+)?)[^\d-]+el(-?\d+(?:\.\d+)?)/i,
  /(-?\d+)_(-?\d+)/,
];

export function parseAzEl(name) {
  for (const pattern of AZ_EL_PATTERNS) {
    const match = name.match(pattern);
    if (!match) continue;
    if (match.length === 5) {
      return [Number(`${match[1]}.${match[2]}`), Number(`${match[3]}.${match[4]}`)];
    }
    return [Number(match[1]), Number(match[2])];
  }
  return null;
}

export function readZipEntries(buffer) {
  let endDirectory = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65558); index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      endDirectory = index;
      break;
    }
  }
  if (endDirectory < 0) throw new Error("不是 zip 文件（找不到 EOCD）");
  const count = buffer.readUInt16LE(endDirectory + 10);
  let offset = buffer.readUInt32LE(endDirectory + 16);
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error(`ZIP central directory 在条目 ${index} 损坏`);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({ name, method, compressedSize, uncompressedSize, dataOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function readZipEntry(buffer, entry) {
  const raw = buffer.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`不支持的 zip 压缩方式 ${entry.method}: ${entry.name}`);
}

export function parseWav(buffer) {
  if (buffer.readUInt32BE(0) !== 0x52494646 || buffer.readUInt32BE(8) !== 0x57415645) {
    throw new Error("不是 RIFF/WAV");
  }
  let offset = 12;
  let formatChunk = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.readUInt32BE(offset);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 0x666d7420) formatChunk = buffer.subarray(offset + 8, offset + 8 + size);
    if (id === 0x64617461) data = buffer.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size & 1);
  }
  if (!formatChunk || !data) throw new Error("WAV 缺 fmt/data 块");
  const format = formatChunk.readUInt16LE(0);
  const channels = formatChunk.readUInt16LE(2);
  const sampleRate = formatChunk.readUInt32LE(4);
  const bitsPerSample = formatChunk.readUInt16LE(14);
  if (channels < 2) throw new Error(`单声道 WAV（${channels}ch）`);
  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(data.length / (channels * bytesPerSample));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    for (const [channel, output] of [[0, left], [1, right]]) {
      const sampleOffset = (frame * channels + channel) * bytesPerSample;
      let value;
      if (format === 3 && bitsPerSample === 32) value = data.readFloatLE(sampleOffset);
      else if (bitsPerSample === 16) value = data.readInt16LE(sampleOffset) / 32768;
      else if (bitsPerSample === 24) {
        value = ((data[sampleOffset] | (data[sampleOffset + 1] << 8) | (data[sampleOffset + 2] << 16)) << 8 >> 8) / 8388608;
      } else if (bitsPerSample === 32) value = data.readInt32LE(sampleOffset) / 2147483648;
      else throw new Error(`不支持的 WAV 格式 fmt=${format} bits=${bitsPerSample}`);
      output[frame] = value;
    }
  }
  return { left, right, sampleRate, channels, bitsPerSample, format };
}

function matchesWav(path, pathFilter) {
  return /\.wav$/i.test(path) && (!pathFilter || path.replaceAll("\\", "/").includes(pathFilter));
}

export async function collectIrs(source, pathFilter) {
  const files = [];
  let archiveBuffer = null;
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${source}`);
    archiveBuffer = Buffer.from(await response.arrayBuffer());
  } else {
    const absolute = resolve(source);
    if (!existsSync(absolute)) throw new Error(`不存在：${absolute}`);
    if (statSync(absolute).isDirectory()) {
      const walk = (directory) => {
        for (const name of readdirSync(directory)) {
          const filePath = join(directory, name);
          if (statSync(filePath).isDirectory()) walk(filePath);
          else if (matchesWav(filePath, pathFilter)) files.push({ path: filePath, read: () => readFileSync(filePath) });
        }
      };
      walk(absolute);
    } else {
      archiveBuffer = readFileSync(absolute);
    }
  }

  if (archiveBuffer) {
    for (const entry of readZipEntries(archiveBuffer)) {
      if (matchesWav(entry.name, pathFilter)) {
        files.push({ path: entry.name, read: () => readZipEntry(archiveBuffer, entry) });
      }
    }
  }

  const impulses = [];
  let skipped = 0;
  for (const file of files) {
    const coordinates = parseAzEl(basename(file.path));
    if (!coordinates) {
      skipped++;
      continue;
    }
    try {
      const wav = parseWav(file.read());
      impulses.push({
        azimuth: coordinates[0],
        elevation: coordinates[1],
        sourcePath: file.path.replaceAll("\\", "/"),
        ...wav,
      });
    } catch {
      skipped++;
    }
  }
  if (impulses.length === 0) {
    throw new Error(`没有可用方向 WAV（路径过滤 ${JSON.stringify(pathFilter)} 命中 ${files.length}，跳过 ${skipped}）`);
  }
  return { impulses, matchedFiles: files.length, skipped };
}

const radians = (degrees) => degrees * Math.PI / 180;

export function directionVector(azimuth, elevation) {
  const azimuthRadians = radians(azimuth);
  const elevationRadians = radians(elevation);
  return [
    Math.cos(elevationRadians) * Math.sin(azimuthRadians),
    Math.cos(elevationRadians) * Math.cos(azimuthRadians),
    Math.sin(elevationRadians),
  ];
}

export function angularDistanceDegrees(aAzimuth, aElevation, bAzimuth, bElevation) {
  const a = directionVector(aAzimuth, aElevation);
  const b = directionVector(bAzimuth, bElevation);
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(dot) * 180 / Math.PI;
}

export function nearestImpulse(impulses, azimuth, elevation) {
  let nearest = null;
  let distanceDegrees = Number.POSITIVE_INFINITY;
  for (const impulse of impulses) {
    const distance = angularDistanceDegrees(azimuth, elevation, impulse.azimuth, impulse.elevation);
    if (distance < distanceDegrees) {
      nearest = impulse;
      distanceDegrees = distance;
    }
  }
  return nearest ? { impulse: nearest, distanceDegrees } : null;
}
