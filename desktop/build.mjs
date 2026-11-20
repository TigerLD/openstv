// Build script for the desktop app.
//
//   node build.mjs            bundle only (app/main.cjs)
//   node build.mjs --package  bundle, package win-unpacked, then build
//                             dist/OpenSTV.exe with the NSIS launcher
//
// The final exe is a thin NSIS launcher: the first run unpacks the Electron app
// into %LOCALAPPDATA%\OpenSTV\<version> and starts it; later runs start the
// already unpacked copy. electron-builder's own `portable` target is not used
// because it deletes the unpacked files on every launch (see notes/07).
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const packageMode = process.argv.includes("--package");

const distDir = join(here, "dist");
const appOutDir = join(here, "build", "out", "win-unpacked");
const exePath = join(distDir, "OpenSTV.exe");
const icon = join(here, "app", "icon.ico");
const nsiPath = join(here, "launcher", "openstv.nsi");
const version = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: here, stdio: "inherit", ...options });
  if (result.error) {
    console.error(`  cannot run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`  ${command} exited with code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

// NSIS is not shipped here: electron-builder downloads it into its cache.
// The extracted folder name contains a hash, so search it recursively.
function findMakensis(root, depth = 0) {
  if (depth > 4 || !existsSync(root)) return null;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === "makensis.exe") {
      return join(root, entry.name);
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findMakensis(join(root, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

console.log("[1/3] bundling src/main.mjs -> app/main.cjs");
await build({
  entryPoints: [join(here, "src", "main.mjs")],
  outfile: join(here, "app", "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  legalComments: "none",
  logLevel: "warning",
});

if (!existsSync(icon)) {
  console.warn("      icon.ico missing: the window will use the default Electron icon");
}

if (!packageMode) {
  console.log("done: app/main.cjs");
  process.exit(0);
}

console.log("[2/3] packaging win-unpacked (electron-builder --win dir)");
const cli = join(here, "node_modules", "electron-builder", "out", "cli", "cli.js");
if (!existsSync(cli)) {
  console.error(`electron-builder not found: ${cli}`);
  process.exit(1);
}
// Older builds left these in dist/: keep the folder holding just the final exe.
for (const stale of ["win-unpacked", "builder-debug.yml", "builder-effective-config.yaml"]) {
  rmSync(join(distDir, stale), { recursive: true, force: true });
}
run(process.execPath, [cli, "--win", "dir"], {
  env: {
    ...process.env,
    ELECTRON_CACHE: join(here, ".cache"),
    ELECTRON_BUILDER_CACHE: join(here, ".cache", "builder"),
  },
});
if (!existsSync(join(appOutDir, "OpenSTV.exe"))) {
  console.error(`packaging failed: ${join(appOutDir, "OpenSTV.exe")} not found`);
  process.exit(1);
}

console.log("[3/3] building dist/OpenSTV.exe (NSIS launcher)");
const makensis =
  findMakensis(join(here, ".cache", "builder", "nsis-3.0.4.1")) ??
  (existsSync("C:\\Program Files (x86)\\NSIS\\makensis.exe")
    ? "C:\\Program Files (x86)\\NSIS\\makensis.exe"
    : null);
if (!makensis) {
  console.error("makensis.exe not found.");
  console.error("It normally comes with electron-builder's cache (.cache/builder/nsis-3.0.4.1).");
  console.error("Install NSIS or run any electron-builder NSIS target once to download it.");
  process.exit(1);
}

run(makensis, [
  "/V2",
  `/DOUTFILE=${exePath}`,
  `/DSOURCEDIR=${appOutDir}`,
  `/DICON=${icon}`,
  `/DAPPVERSION=${version}`,
  nsiPath,
]);

if (!existsSync(exePath)) {
  console.error(`launcher build failed: ${exePath} not found`);
  process.exit(1);
}
const size = statSync(exePath).size;
console.log(`done: ${exePath} (${(size / 1024 / 1024).toFixed(1)} MiB, version ${version})`);
