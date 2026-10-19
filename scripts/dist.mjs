import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const builtin = new Set(builtinModules);
const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:";

if (process.platform !== "win32") {
  process.stderr.write(
    "npm run dist 只在 Windows 組出含 runtime 的執行檔。這台機器不是 win32，不會假裝已經做出 macOS 執行檔。\n",
  );
  process.exit(1);
}

const tsc = spawnSync(
  process.execPath,
  [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "."],
  { cwd: root, stdio: "inherit" },
);
if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1);
}

const entry = path.join(root, "dist", "entry.js");
const bundlePath = path.join(root, "dist", "sea-main.cjs");
fs.writeFileSync(bundlePath, bundle(entry));
const checked = spawnSync(process.execPath, ["--check", bundlePath], {
  cwd: root,
  stdio: "inherit",
});
if (checked.status !== 0) {
  process.exit(checked.status ?? 1);
}

const helloJs = path.join(root, "dist", "sea-hello.js");
const helloExe = path.join(root, "dist", "sea-hello.exe");
fs.writeFileSync(helloJs, 'console.log("sea-ok")\n');
buildSea({
  main: helloJs,
  blob: path.join(root, "dist", "sea-hello.blob"),
  exe: helloExe,
  assets: {},
});
const hello = spawnSync(helloExe, [], { cwd: root, encoding: "utf8" });
if (hello.status !== 0 || !String(hello.stdout).includes("sea-ok")) {
  process.stderr.write(hello.stdout ?? "");
  process.stderr.write(hello.stderr ?? "");
  process.stderr.write("SEA 注入後的測試執行檔沒有印出 sea-ok。\n");
  process.exit(1);
}
fs.rmSync(helloJs, { force: true });
fs.rmSync(helloExe, { force: true });
fs.rmSync(path.join(root, "dist", "sea-hello.blob"), { force: true });

const exe = path.join(root, "dist", "VansPod.exe");
buildSea({
  main: bundlePath,
  blob: path.join(root, "dist", "sea-prep.blob"),
  exe,
  assets: {
    "tray.ps1": path.join(root, "scripts", "tray.ps1"),
    "uninstall.ps1": path.join(root, "scripts", "uninstall.ps1"),
    "update.ps1": path.join(root, "scripts", "update.ps1"),
    "brand-logo.png": path.join(root, "media", "brand-logo.png"),
    "fadou-superhero.png": path.join(root, "media", "fadou-superhero.png"),
    "fadou-superhero-blink.png": path.join(root, "media", "fadou-superhero-blink.png"),
    "brand-icon.ico": path.join(root, "media", "brand-icon.ico"),
  },
  icon: path.join(root, "media", "brand-icon.ico"),
});
process.stdout.write(`VansPod executable: ${exe}\n`);

function buildSea({ main, blob, exe, assets, icon }) {
  const config = {
    main,
    output: blob,
    disableExperimentalSEAWarning: true,
    assets,
  };
  const configPath = `${blob}.json`;
  fs.writeFileSync(configPath, JSON.stringify(config));
  const generated = spawnSync(
    process.execPath,
    ["--experimental-sea-config", configPath],
    { cwd: root, stdio: "inherit" },
  );
  if (generated.status !== 0) {
    process.exit(generated.status ?? 1);
  }
  fs.copyFileSync(process.execPath, exe);
  const injected = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "scripts", "inject-sea.ps1"),
      "-Exe",
      exe,
      "-Blob",
      blob,
      ...(icon ? ["-Icon", icon] : []),
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (injected.status !== 0) {
    process.exit(injected.status ?? 1);
  }
  flipFuse(exe);
}

function flipFuse(exe) {
  const bytes = fs.readFileSync(exe);
  const needle = Buffer.from(`${fuse}0`, "utf8");
  const at = bytes.indexOf(needle);
  if (at < 0) {
    process.stderr.write("Node 執行檔裡找不到 SEA fuse，無法標成單一執行檔。\n");
    process.exit(1);
  }
  bytes[at + needle.length - 1] = "1".charCodeAt(0);
  fs.writeFileSync(exe, bytes);
  const flipped = fs.readFileSync(exe);
  if (flipped.indexOf(Buffer.from(`${fuse}1`, "utf8")) < 0) {
    process.stderr.write("SEA fuse 沒有改成已注入。\n");
    process.exit(1);
  }
}

function bundle(entryFile) {
  const files = new Map();
  const links = [];
  const seen = new Set();
  const visit = (file) => {
    const id = path.resolve(file);
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    const source = fs.readFileSync(id, "utf8");
    files.set(id, source);
    for (const spec of requireSpecs(source)) {
      if (isBuiltin(spec)) {
        continue;
      }
      let resolved;
      try {
        resolved = resolveSpec(id, spec);
      } catch {
        continue;
      }
      links.push([id, spec, resolved]);
      visit(resolved);
    }
  };
  visit(entryFile);
  const factories = [];
  for (const [id, source] of files) {
    if (id.endsWith(".json")) {
      factories.push(
        `__define(${JSON.stringify(id)}, function(exports, require, module) {\nmodule.exports = ${source};\n});`,
      );
      continue;
    }
    factories.push(
      `__define(${JSON.stringify(id)}, function(exports, require, module, __filename, __dirname) {\n${source}\n});`,
    );
  }
  const linkLines = links.map(
    ([from, spec, resolved]) =>
      `  [${JSON.stringify(`${from}\0${spec}`)}, ${JSON.stringify(resolved)}],`,
  );
  return `"use strict";
const __nodeRequire = require;
const __factories = new Map();
const __cache = new Map();
const __links = new Map([
${linkLines.join("\n")}
]);
function __define(id, factory) { __factories.set(id, factory); }
function __load(id) {
  const cached = __cache.get(id);
  if (cached) return cached.exports;
  const factory = __factories.get(id);
  if (!factory) throw new Error("missing module " + id);
  const module = { exports: {} };
  __cache.set(id, module);
  const localRequire = (spec) => {
    const linked = __links.get(id + "\\0" + spec);
    if (linked) return __load(linked);
    return __nodeRequire(spec);
  };
  factory.call(module.exports, module.exports, localRequire, module, id, __nodeRequire("path").dirname(id));
  return module.exports;
}
${factories.join("\n")}
__load(${JSON.stringify(path.resolve(entryFile))});
`;
}

function requireSpecs(source) {
  const specs = [];
  const pattern = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    specs.push(match[2]);
  }
  return specs;
}

function isBuiltin(spec) {
  if (builtin.has(spec)) {
    return true;
  }
  if (spec.startsWith("node:")) {
    return builtin.has(spec) || builtin.has(spec.slice(5));
  }
  return false;
}

function resolveSpec(fromFile, spec) {
  if (spec.startsWith(".")) {
    const base = path.resolve(path.dirname(fromFile), spec);
    const candidates = [
      base,
      `${base}.js`,
      `${base}.cjs`,
      `${base}.json`,
      path.join(base, "index.js"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return path.resolve(candidate);
      }
    }
    throw new Error(`cannot resolve ${spec} from ${fromFile}`);
  }
  return require.resolve(spec, { paths: [path.dirname(fromFile)] });
}
