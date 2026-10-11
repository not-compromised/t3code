// What the fork's nightly pipeline promises, tested from the outside:
// it ships only upstream nightlies, never ships a phone/server protocol change
// by itself, refuses fork changes that the stock servers or the phone would
// see, and keeps its push credentials away from jobs that run repository code.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { selectNightly } = require("./select-nightly.cjs");

const here = __dirname;
const workflow = fs.readFileSync(path.join(here, "../workflows/fork-nightly.yml"), "utf8");

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fork-pipeline-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const run = (script, ...args) =>
    spawnSync("bash", [path.join(here, script), ...args], { cwd: dir, encoding: "utf8" });
  return { dir, git, write, commit, run };
}

// --- Which upstream build the fork follows -------------------------------

test("ships the newest upstream nightly", () => {
  const releases = [
    { tag_name: "v0.0.46-nightly.20261011.2994", draft: false },
    { tag_name: "v0.0.46-nightly.20261011.2980", draft: false },
  ];
  assert.equal(selectNightly(releases), "v0.0.46-nightly.20261011.2994");
});

test("never follows a draft, preview, PR build or stable release", () => {
  const releases = [
    { tag_name: "v0.0.46-nightly.20261012.3001", draft: true },
    { tag_name: "v0.0.46-preview.20261012.3000", draft: false },
    { tag_name: "v0.0.46-pr.18200.1", draft: false },
    { tag_name: "v0.0.45", draft: false },
    { tag_name: "v0.0.46-nightly.20261011.2994", draft: false },
  ];
  assert.equal(selectNightly(releases), "v0.0.46-nightly.20261011.2994");
});

test("finds nothing rather than guessing when upstream has no nightly", () => {
  assert.equal(selectNightly([{ tag_name: "v0.0.45", draft: false }]), null);
  const cli = spawnSync("node", [path.join(here, "select-nightly.cjs")], {
    input: JSON.stringify([{ tag_name: "v0.0.45", draft: false }]),
    encoding: "utf8",
  });
  assert.equal(cli.status, 1);
});

test("a release carries the upstream version unchanged, so servers and the app agree", () => {
  // The skew banner compares nightly versions in full; any suffix would make
  // the desktop app newer than every server.
  assert.match(workflow, /version="\$\{tag#v\}"/);
  assert.match(workflow, /--build-version "\$\{\{ needs\.rebase\.outputs\.version \}\}"/);
  assert.match(workflow, /gh release create "\$TAG"/);
});

// --- The phone's protocol ------------------------------------------------

const protocolFile = "packages/contracts/src/environment.ts";
const protocol = (n) => `export const ORCHESTRATION_PROTOCOL_VERSION = ${n};\n`;

test("an unchanged protocol ships", () => {
  const r = repo();
  r.write(protocolFile, protocol(2));
  const base = r.commit("base");
  r.write("apps/web/src/a.ts", "x\n");
  const target = r.commit("target");
  const result = r.run("protocol-guard.sh", base, target);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("a protocol change holds instead of shipping", () => {
  const r = repo();
  r.write(protocolFile, protocol(2));
  const base = r.commit("base");
  r.write(protocolFile, protocol(3));
  const target = r.commit("target");
  const result = r.run("protocol-guard.sh", base, target);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /2 -> 3/);
});

test("an unreadable protocol holds rather than shipping blind", () => {
  const r = repo();
  r.write(protocolFile, protocol(2));
  const base = r.commit("base");
  fs.rmSync(path.join(r.dir, protocolFile));
  const target = r.commit("moved");
  assert.equal(r.run("protocol-guard.sh", base, target).status, 1);
});

test("the protocol guard can only be skipped by an explicit manual input", () => {
  assert.match(workflow, /if: steps\.plan\.outputs\.skip == 'false' && !inputs\.allow_protocol_change/);
  assert.match(workflow, /allow_protocol_change:[\s\S]*?default: false/);
});

// --- What the fork may change ---------------------------------------------

function boundary(changes, exceptions) {
  const r = repo();
  r.write("README.md", "base\n");
  const base = r.commit("base");
  for (const file of changes) r.write(file, "changed\n");
  if (exceptions) r.write(".github/fork/boundary-exceptions", exceptions.join("\n") + "\n");
  r.commit("change");
  return r.run("check-boundaries.sh", base);
}

test("desktop and web changes pass", () => {
  const result = boundary(["apps/desktop/src/x.ts", "apps/web/src/y.tsx", "packages/contracts/src/ipc.ts"]);
  assert.equal(result.status, 0, result.stdout);
});

for (const file of [
  "apps/server/src/ws.ts",
  "apps/mobile/src/App.tsx",
  "packages/client-runtime/src/connection/compatibility.ts",
  "packages/contracts/src/environment.ts",
  "packages/provider-grok/src/index.ts",
]) {
  test(`a change the servers or phone would see is refused: ${file}`, () => {
    const result = boundary([file]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
}

test("an owner-approved exception passes, and only that path", () => {
  const ok = boundary(["apps/server/src/environmentTheme.ts"], ["apps/server/src/environmentTheme.ts"]);
  assert.equal(ok.status, 0, ok.stdout);
  const other = boundary(
    ["apps/server/src/environmentTheme.ts", "apps/server/src/ws.ts"],
    ["apps/server/src/environmentTheme.ts"],
  );
  assert.equal(other.status, 1);
});

test("shared helpers pass with a warning to check servers and the phone", () => {
  const result = boundary(["packages/shared/src/themeFile.ts"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /::warning/);
});

// --- Credentials and rewrites ---------------------------------------------

function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `job ${name} exists`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(3).search(/\n {2}[a-z_]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 3);
}

test("the push key never reaches jobs that run repository code", () => {
  for (const name of ["check", "build"]) {
    assert.doesNotMatch(job(name), /FORK_DEPLOY_KEY/, `${name} sees the deploy key`);
    assert.doesNotMatch(job(name), /contents: write/, `${name} can write`);
  }
  assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
});

test("the push key lives only in the two push steps, which run no repository code", () => {
  const steps = workflow.split(/\n {6}- /).slice(1);
  const holding = steps.filter((step) => step.includes("FORK_DEPLOY_KEY"));
  assert.deepEqual(
    holding.map((step) => step.match(/name: (.+)/)[1]),
    ["Rebase", "Move branches"],
  );
  for (const step of holding) {
    assert.doesNotMatch(step, /\.github\/fork|\bnode |\bvp |\bbash \S/, "a key-holding step runs repository code");
    assert.doesNotMatch(step, /GIT_SSH_COMMAND[^\n]*GITHUB_ENV/, "the key's ssh command must not outlive its step");
    assert.match(step, /trap 'rm -f ~\/\.ssh\/fork_deploy' EXIT/);
  }
});

test("custom is only ever replaced under a lease on the tip that was rebased", () => {
  const publish = job("publish");
  assert.match(publish, /--force-with-lease="custom:\$OLD_CUSTOM"/);
  assert.doesNotMatch(publish.replace(/--force-with-lease="custom:\$OLD_CUSTOM"[^\n]*/, ""), /:refs\/heads\/custom/);
});

test("nothing ships unless the rebase, the checks and the build all passed", () => {
  const publish = job("publish");
  assert.match(publish, /needs: \[rebase, check, build\]/);
  assert.match(publish, /needs\.check\.result == 'success' && needs\.build\.result == 'success'/);
});

test("the published files are exactly what the updater reads", () => {
  const uploaded = job("build")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("release/"));
  assert.deepEqual(uploaded, ["release/*.AppImage", "release/nightly-linux.yml"]);
});
