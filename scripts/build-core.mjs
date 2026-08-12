// Build the sda-core wasm artifacts:
//   cargo build --target wasm32-unknown-unknown --release
//   wasm-bindgen --target web     → packages/core/pkg-web   (browser/Electron)
//   wasm-bindgen --target nodejs  → packages/core/pkg-node  (tests/CLI)
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renameSync } from "node:fs";

const coreDir = join(dirname(fileURLToPath(import.meta.url)), "../packages/core");
const wasm = join(coreDir, "target/wasm32-unknown-unknown/release/sda_core.wasm");

const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: coreDir, stdio: "inherit", shell: process.platform === "win32" });

console.log("== cargo build (wasm32, release) ==");
run("cargo", ["build", "--target", "wasm32-unknown-unknown", "--release"]);

for (const target of ["web", "nodejs"]) {
  const outDir = join(coreDir, target === "web" ? "pkg-web" : "pkg-node");
  console.log(`== wasm-bindgen --target ${target} → ${outDir} ==`);
  run("wasm-bindgen", ["--target", target, "--out-dir", outDir, wasm]);
  if (target === "nodejs") {
    renameSync(join(outDir, "sda_core.js"), join(outDir, "sda_core.cjs"));
  }
}
console.log("done");
