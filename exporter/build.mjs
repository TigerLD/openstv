// Build a standalone Windows executable: node.exe + SEA blob -> dist/OpenSTV.exe
//
//   node build.mjs
//
// Requires (already installed in exporter/node_modules): esbuild, postject.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postject from "postject";

const root = dirname(fileURLToPath(import.meta.url));
const buildDir = join(root, "build");
const distDir = join(root, "dist");
const bundlePath = join(buildDir, "openstv.cjs");
const configPath = join(buildDir, "sea-config.json");
const blobPath = join(buildDir, "openstv.blob");
const exePath = join(distDir, "OpenSTV.exe");
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

mkdirSync(buildDir, { recursive: true });
mkdirSync(distDir, { recursive: true });

console.log("[1/4] bundling cli.mjs -> build/openstv.cjs");
await build({
  entryPoints: [join(root, "cli.mjs")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  outfile: bundlePath,
  legalComments: "none",
  banner: { js: "/* OpenSTV — Node.js Single Executable Application build */" },
  logLevel: "warning",
});

console.log("[2/4] generating SEA blob");
writeFileSync(
  configPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
    },
    null,
    2
  )
);
const sea = spawnSync(process.execPath, ["--experimental-sea-config", configPath], { stdio: "inherit" });
if (sea.status !== 0) {
  console.error("sea-config failed");
  process.exit(sea.status ?? 1);
}

console.log("[3/4] copying node.exe");
retry(() => {
  if (existsSync(exePath)) rmSync(exePath, { force: true });
  copyFileSync(process.execPath, exePath);
});

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Antivirus may briefly hold a freshly written 92 MB executable; retry instead of failing.
function retry(fn, attempts = 12, delayMs = 700) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (e) {
      last = e;
      if (!["EBUSY", "EPERM", "EACCES", "ENOENT"].includes(e.code)) throw e;
      sleepSync(delayMs);
    }
  }
  throw last;
}

console.log("[4/4] injecting blob into OpenSTV.exe");
await postject.inject(exePath, "NODE_SEA_BLOB", readFileSync(blobPath), { sentinelFuse: FUSE });

// Two flavours of the same binary:
//   OpenSTV.exe      - Windows GUI subsystem: double-click opens the browser UI, no console window.
//   OpenSTV-cli.exe  - console subsystem: normal command-line output.
function setSubsystem(file, value, label) {
  const buf = readFileSync(file);
  const peOffset = buf.readUInt32LE(0x3c);
  const subsystemOffset = peOffset + 0x5c;
  const current = buf.readUInt16LE(subsystemOffset);
  if (current !== 2 && current !== 3) {
    throw new Error(`unexpected PE subsystem ${current} in ${file}`);
  }
  buf.writeUInt16LE(value, subsystemOffset);
  retry(() => writeFileSync(file, buf));
  console.log(`      ${label}: subsystem ${current} -> ${value}`);
}

setSubsystem(exePath, 2, "OpenSTV.exe");

const cliPath = join(distDir, "OpenSTV-cli.exe");
retry(() => {
  if (existsSync(cliPath)) rmSync(cliPath, { force: true });
  copyFileSync(exePath, cliPath);
});
setSubsystem(cliPath, 3, "OpenSTV-cli.exe");

const mb = (statSync(exePath).size / 1048576).toFixed(1);
console.log(`done: ${exePath} (${mb} MB) and ${cliPath}`);
