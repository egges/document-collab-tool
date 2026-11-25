// Puts the Git that ships with the app in src-tauri/git, which Tauri bundles
// as a resource (see tauri.conf.json). Runs before every `tauri build`, and
// by hand (`npm run fetch-git`) to try the bundled Git in development.
//
// The build's platform comes from Tauri (TAURI_ENV_PLATFORM/TAURI_ENV_ARCH),
// or from `--target darwin-aarch64` etc., or else this computer.
//
// Downloads are checked against the hashes in git.json and cached in
// src-tauri/target/git-download. The parts the app never uses are left out:
// Git Credential Manager (the app signs in itself), Git LFS and Scalar.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(appDir, "git.json"), "utf8"));
const gitDir = join(appDir, "src-tauri", "git");
const cacheDir = join(appDir, "src-tauri", "target", "git-download");
const stampFile = join(gitDir, "bundled.json");

// Kept in src-tauri/git, which git tracks so the resource folder always exists.
const KEEP = new Set(["README.md"]);

const host = `${{ darwin: "darwin", linux: "linux", win32: "windows" }[process.platform]}-${
  { arm64: "aarch64", x64: "x86_64" }[process.arch]
}`;

function target() {
  const flag = process.argv.indexOf("--target");
  if (flag !== -1) return process.argv[flag + 1];
  if (process.env.TAURI_ENV_PLATFORM && process.env.TAURI_ENV_ARCH) {
    return `${process.env.TAURI_ENV_PLATFORM}-${process.env.TAURI_ENV_ARCH}`;
  }
  return host;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function download(entry) {
  const file = join(cacheDir, entry.file);
  if (existsSync(file) && sha256(file) === entry.sha256) return file;
  mkdirSync(cacheDir, { recursive: true });
  const url = `${manifest.release}/${entry.file}`;
  console.log(`fetch-git: downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  const actual = sha256(file);
  if (actual !== entry.sha256) {
    rmSync(file);
    throw new Error(`${entry.file}: expected sha256 ${entry.sha256}, got ${actual}`);
  }
  return file;
}

/** Leave out what the app doesn't use, and replace symbolic links, which
 * the bundle would copy as whole files (macOS and Linux link about 150
 * commands to the 4 MB `git` program). */
function prune(dir) {
  const unwanted =
    /^(git-credential-manager.*|git-lfs(\.exe)?|scalar(\.exe)?|createdump|uninstall\.sh)$|\.(dll|dylib|so)$/;
  const unixCore = join(dir, "libexec", "git-core");
  if (existsSync(unixCore)) {
    // Commands git runs by their own name rather than as `git <command>`:
    // the other side of a push or fetch to a folder, and HTTPS.
    const linksToKeep = new Set(["git-upload-pack", "git-receive-pack", "git-upload-archive", "git-remote-https"]);
    for (const name of readdirSync(unixCore)) {
      const path = join(unixCore, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const source = resolve(unixCore, readlinkSync(path));
        rmSync(path);
        if (linksToKeep.has(name)) {
          copyFileSync(source, path);
          chmodSync(path, 0o755);
        }
      } else if (stat.isDirectory()) {
        // Git Credential Manager's translations; mergetools is git's own.
        if (name !== "mergetools") rmSync(path, { recursive: true });
      } else if (unwanted.test(name)) {
        rmSync(path);
      }
    }
    rmSync(join(dir, "bin", "scalar"), { force: true });
  } else {
    for (const sub of ["cmd", ...readdirSync(dir).flatMap((d) => [join(d, "bin"), join(d, "libexec", "git-core")])]) {
      const path = join(dir, sub);
      if (!existsSync(path) || !lstatSync(path).isDirectory()) continue;
      for (const name of readdirSync(path)) {
        if (/^(git-lfs|scalar)\.exe$/.test(name)) rmSync(join(path, name));
      }
    }
  }
  const links = [];
  const walk = (path) => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) links.push(child);
      else if (stat.isDirectory()) walk(child);
    }
  };
  walk(dir);
  if (links.length) throw new Error(`fetch-git: symbolic links left in the bundle:\n${links.join("\n")}`);
}

async function main() {
  const name = target();
  const entry = manifest.targets[name];
  if (!entry) {
    throw new Error(
      `fetch-git: no bundled Git for ${name}. Known: ${Object.keys(manifest.targets).join(", ")}. ` +
        "(A universal macOS build would need both architectures merged; not done yet.)",
    );
  }
  const stamp = { version: manifest.version, target: name, file: entry.file };
  if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === JSON.stringify(stamp, null, 2)) {
    console.log(`fetch-git: Git ${manifest.version} for ${name} is already in place`);
    return;
  }
  const archive = await download(entry);

  const staging = `${gitDir}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", staging], { stdio: "inherit" });
  prune(staging);

  mkdirSync(gitDir, { recursive: true });
  for (const name of readdirSync(gitDir)) {
    if (!KEEP.has(name)) rmSync(join(gitDir, name), { recursive: true, force: true });
  }
  for (const name of readdirSync(staging)) renameSync(join(staging, name), join(gitDir, name));
  rmSync(staging, { recursive: true, force: true });
  writeFileSync(stampFile, JSON.stringify(stamp, null, 2));

  // Check that it runs, when it was built for this computer.
  if (name === host) {
    const windows = name.startsWith("windows");
    const binary = windows ? join(gitDir, "cmd", "git.exe") : join(gitDir, "bin", "git");
    const env = windows ? process.env : { ...process.env, GIT_EXEC_PATH: join(gitDir, "libexec", "git-core") };
    const version = execFileSync(binary, ["--version"], { env }).toString().trim();
    console.log(`fetch-git: ${version} in ${gitDir}`);
  } else {
    console.log(`fetch-git: Git ${manifest.version} for ${name} in ${gitDir}`);
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
