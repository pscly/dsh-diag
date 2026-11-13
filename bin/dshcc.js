#!/usr/bin/env node
/**
 * dshcc — DeepSeek Harness Companion CLI.
 *
 * Answers the questions that come up when a DSH install misbehaves: which
 * profiles exist, what each one has installed, whether a plugin's declared
 * compatibility covers the running engine, and whether the credential store is
 * locked down. Everything is read from disk; nothing is modified.
 *
 * Unofficial. Not part of DeepSeek Harness.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

const HOME = () => process.env.DSH_HOME ?? join(homedir(), ".dsh");

const HELP = `dshcc ${VERSION} — DeepSeek Harness Companion CLI

用法
  dshcc profiles              列出所有 profile 及其插件数量
  dshcc plugins [--profile P] 列出某个 profile 安装的插件（默认全部）
  dshcc doctor                检查 DSH_HOME、profile、凭据文件权限与版本兼容
  dshcc --version

全部为只读操作，不会修改任何文件。

示例
  dshcc profiles
  dshcc plugins --profile web
  DSH_HOME=/srv/dsh dshcc doctor
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[name] = true;
      else {
        out[name] = next;
        i += 1;
      }
    } else out._.push(arg);
  }
  return out;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Every directory under `<DSH_HOME>/profiles` that carries a manifest. */
function profiles() {
  const dir = join(HOME(), "profiles");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const manifest = readJson(join(dir, name, "package.json"));
    if (manifest === undefined) continue;
    out.push({ name, dir: join(dir, name), manifest });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Plugin rows the profile composes, from `dsh.profile.bundles`. */
function bundles(manifest) {
  const list = manifest?.dsh?.profile?.bundles;
  return Array.isArray(list) ? list.map(String) : [];
}

/** Community plugins, from the profile's dependency block. */
function dependencies(manifest) {
  return Object.entries(manifest?.dependencies ?? {}).map(([name, range]) => ({
    name,
    range: String(range),
  }));
}

/** The plugin's own declared compatibility window, when it ships one. */
function compatibility(profileDir, name) {
  const manifest = readJson(join(profileDir, "node_modules", name, "package.json"));
  if (manifest === undefined) return undefined;
  const dsh = manifest?.dsh;
  return {
    version: manifest.version,
    bundle: Boolean(dsh?.bundle?.patch),
    client: dsh?.client?.platform ?? null,
    engines: manifest?.engines?.dsh ?? null,
    releases: dsh?.compatibility?.dsh ?? null,
  };
}

function cmdProfiles() {
  const list = profiles();
  if (list.length === 0) {
    console.log(`没有找到任何 profile：${join(HOME(), "profiles")}`);
    return;
  }
  console.log(`DSH_HOME  ${HOME()}`);
  console.log("");
  for (const profile of list) {
    const deps = dependencies(profile.manifest);
    const composed = bundles(profile.manifest).length;
    const patched = existsSync(join(profile.dir, "cordis.patch.yml"));
    console.log(
      `${profile.name.padEnd(12)} 依赖 ${String(deps.length).padStart(2)}  组合 ${String(composed).padStart(2)}` +
        `${patched ? "  有 patch" : ""}`,
    );
  }
}

function cmdPlugins(args) {
  const wanted = typeof args.profile === "string" ? args.profile : undefined;
  const list = profiles().filter((p) => wanted === undefined || p.name === wanted);
  if (list.length === 0) {
    console.log(wanted === undefined ? "没有找到 profile。" : `没有名为 ${wanted} 的 profile。`);
    return;
  }
  for (const profile of list) {
    const deps = dependencies(profile.manifest);
    console.log(`\n[${profile.name}] ${deps.length} 个插件`);
    if (deps.length === 0) {
      console.log("  （无）");
      continue;
    }
    for (const dep of deps) {
      const facts = compatibility(profile.dir, dep.name);
      const flags = [];
      if (facts?.bundle) flags.push("bundle");
      if (facts?.client) flags.push(`client:${facts.client}`);
      console.log(
        `  ${dep.name}@${facts?.version ?? dep.range}` +
          (flags.length > 0 ? `  ${flags.join(" ")}` : ""),
      );
    }
  }
}

/** Warn when a plugin's declared DSH window excludes the running engine. */
function compatibilityWarnings(profile, engineVersion) {
  const warnings = [];
  if (engineVersion === undefined) return warnings;
  for (const dep of dependencies(profile.manifest)) {
    const facts = compatibility(profile.dir, dep.name);
    if (facts === undefined) {
      warnings.push(`${dep.name} 已在依赖里但没有装到 node_modules`);
      continue;
    }
    if (facts.engines === null && facts.releases === null) continue;
    if (satisfiesAny(facts.engines ?? facts.releases, engineVersion)) continue;
    warnings.push(`${dep.name}@${facts.version} 声明兼容 ${facts.engines ?? facts.releases}，当前 ${engineVersion}`);
  }
  return warnings;
}

/** A deliberately small range check: enough for the exact pinned forms DSH uses. */
function satisfiesAny(range, version) {
  if (typeof range !== "string" || range === "") return true;
  if (range.includes("||")) return range.split("||").some((part) => satisfiesAny(part.trim(), version));
  const comparators = range.trim().split(/\s+/);
  for (const token of comparators) {
    const match = token.match(/^(>=|<=|>|<|=|\^|~)?\s*v?(\d+\.\d+\.\d+(?:-[\w.]+)?)$/);
    if (!match) continue;
    const [, op = "=", target] = match;
    if (!compare(op, target, version)) return false;
  }
  return true;
}

function compare(op, target, version) {
  const order = compareVersions(version, target);
  switch (op) {
    case ">=": return order >= 0;
    case ">": return order > 0;
    case "<=": return order <= 0;
    case "<": return order < 0;
    case "^": return order >= 0 && version.split(".")[0] === target.split(".")[0];
    case "~": return order >= 0 && version.split(".").slice(0, 2).join(".") === target.split(".").slice(0, 2).join(".");
    default: return order === 0;
  }
}

function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre] = String(v).split("-");
    return { parts: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  // A prerelease sorts below the same core version.
  if (left.pre === undefined && right.pre === undefined) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre.localeCompare(right.pre);
}

/**
 * The running engine version.
 *
 * A profile rarely owns `@deepseek-ai/dsh` — it is usually installed globally
 * or in a checkout — so fall back to asking the CLI itself.
 * @returns {string | undefined}
 */
function engineVersion() {
  for (const profile of profiles()) {
    const manifest = readJson(join(profile.dir, "node_modules", "@deepseek-ai", "dsh", "package.json"));
    if (manifest?.version) return manifest.version;
  }
  try {
    const out = execFileSync("dsh", ["--version"], { encoding: "utf8", timeout: 15000 }).trim();
    const match = out.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/);
    if (match) return match[0];
  } catch {
    // No CLI on PATH is a normal state for a support machine.
  }
  return undefined;
}

function cmdDoctor() {
  const home = HOME();
  const checks = [];

  checks.push({
    label: "DSH_HOME",
    ok: existsSync(home),
    detail: existsSync(home) ? home : `${home} 不存在`,
  });

  const list = profiles();
  checks.push({
    label: "profiles",
    ok: list.length > 0,
    detail: list.length > 0 ? list.map((p) => p.name).join("、") : "一个都没有",
  });

  const engine = engineVersion();
  checks.push({
    label: "引擎版本",
    ok: engine !== undefined,
    detail: engine ?? "profile 的 node_modules 里找不到 @deepseek-ai/dsh",
  });

  const credentials = join(home, ".credentials.yaml");
  if (existsSync(credentials)) {
    const mode = statSync(credentials).mode & 0o777;
    checks.push({
      label: "凭据文件权限",
      ok: (mode & 0o077) === 0,
      detail: `${credentials} ${mode.toString(8)}${(mode & 0o077) === 0 ? "" : "（其他用户可读，建议 chmod 600）"}`,
    });
  } else {
    checks.push({ label: "凭据文件", ok: true, detail: "尚无（首次保存密钥时创建）" });
  }

  console.log(`dshcc ${VERSION}  节点 ${process.version}\n`);
  let failed = 0;
  for (const check of checks) {
    if (!check.ok) failed += 1;
    console.log(`  ${check.ok ? "✓" : "✗"} ${check.label.padEnd(10)} ${check.detail}`);
  }

  for (const profile of profiles()) {
    const warnings = compatibilityWarnings(profile, engine);
    for (const warning of warnings) {
      failed += 1;
      console.log(`  ✗ ${`[${profile.name}]`.padEnd(10)} ${warning}`);
    }
  }

  console.log("");
  console.log(failed === 0 ? "没有发现问题。" : `${failed} 项需要注意。`);
  if (failed > 0) process.exitCode = 1;
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(VERSION);
    return;
  }

  switch (command) {
    case "profiles":
      return cmdProfiles();
    case "plugins":
      return cmdPlugins(args);
    case "doctor":
      return cmdDoctor();
    default:
      console.error(`未知命令：${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main();
