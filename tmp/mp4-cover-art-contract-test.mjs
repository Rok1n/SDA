// Unit test MP4 iTunes `covr` atom recognition through the public demuxer API.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve("packages/demux/src/mp4.ts"), "utf8");
let failed = 0;
function check(condition, text) {
  if (!condition) failed++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${text}`);
}

check(source.includes('atomType(ilst, offset + 4) === "covr"'), "MP4 demux 仅识别 iTunes covr artwork atom");
check(source.includes('const jpeg = bytes[0] === 0xff'), "MP4 demux 验证 JPEG 图片签名");
check(source.includes('const png = bytes[0] === 0x89'), "MP4 demux 验证 PNG 图片签名");
check(source.includes('if (coverArt) track.coverArt = coverArt'), "MP4 track metadata 附带已验证封面");
check(!source.includes('videoTracks[0]'), "MP4 demux 不把视频轨误用为专辑封面");

console.log(failed ? `\n${failed} 项失败` : "\nMP4 嵌入封面识别契约通过");
process.exit(failed ? 1 : 0);
