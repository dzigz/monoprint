import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(readFileSync(path.join(root, "runtime-lock.json"), "utf8"));
const settings = dotenv.parse(readFileSync(path.join(root, ".env.local")));
const env = { ...settings, ...process.env };
const pipeline = path.join(root, ".local/pipeline");
const python = path.join(root, ".local/python/bin/python");
const wrapper = path.join(pipeline, "scripts/matching/python.sh");

if (process.versions.node !== lock.node) {
  throw new Error(`Expected Node ${lock.node}; run npm run local with the prepared runtime.`);
}
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: pipeline, encoding: "utf8" }).trim();
if (revision !== lock.pipeline.revision) {
  throw new Error(`Expected pipeline ${lock.pipeline.revision}, found ${revision}. Update the recorded pair after validation.`);
}
execFileSync("git", ["diff", "--exit-code", "HEAD", "--", ".", ":(exclude)**/.DS_Store", ":(exclude).DS_Store"], { cwd: pipeline, stdio: "pipe" });
const pythonVersion = execFileSync(python, ["-c", "import platform; print(platform.python_version())"], { encoding: "utf8" }).trim();
if (pythonVersion !== lock.python) throw new Error(`Expected Python ${lock.python}, found ${pythonVersion}.`);

const sidecarPort = env.SIDECAR_PORT ?? "4174";
const appPort = env.PORT ?? "4175";
const sidecarUrl = `http://127.0.0.1:${sidecarPort}`;
const children = new Set();
const done = new Promise((resolve) => {
  let stopping = false;
  const stop = (code) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) signal(child, "SIGTERM");
    const deadline = setTimeout(() => {
      for (const child of children) signal(child, "SIGKILL");
      resolve(code);
    }, 6000);
    const finish = () => {
      if (!children.size) { clearTimeout(deadline); resolve(code); }
    };
    for (const child of children) child.once("exit", finish);
    finish();
  };
  function signal(child, name) {
    try {
      if (process.platform === "win32") child.kill(name);
      else process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") console.error(error.message);
    }
  }
  function start(name, command, args, options) {
    const child = spawn(command, args, { stdio: "inherit", detached: process.platform !== "win32", ...options });
    children.add(child);
    child.once("error", (error) => { children.delete(child); console.error(`${name}: ${error.message}`); stop(1); });
    child.once("exit", (code, signal) => {
      children.delete(child);
      if (!stopping) { console.error(`${name} stopped (${signal ?? code}).`); stop(code || (signal ? 1 : 0)); }
    });
    return child;
  }
  process.once("SIGINT", () => stop(0));
  process.once("SIGTERM", () => stop(0));
  console.log(`Monoprint local: pipeline ${revision.slice(0, 12)}, Node ${lock.node}, Python ${pythonVersion}`);
  start("Pipeline", "sh", [wrapper, "scripts/matching/sidecar.py", sidecarPort], {
    cwd: pipeline,
    // The pipeline loads its own private .env; app credentials stay with the app.
    env: { ...process.env, SIDECAR_PYTHON: python, DESIGN_AGENT_MODE: env.SIDECAR_DESIGN_AGENT_MODE ?? "aesthetic" },
  });
  void (async () => {
    for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
      let ready = false;
      try { ready = (await fetch(`${sidecarUrl}/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* still starting */ }
      if (ready && !stopping) {
        start("Monoprint", process.execPath, [path.join(root, "node_modules/tsx/dist/cli.mjs"), "watch", "server/index.ts"], {
          cwd: root,
          env: { ...env, NODE_ENV: "development", PORT: appPort, TEXT_LAYER_SIDECAR_URL: sidecarUrl, SIDECAR_RUNS_DIR: path.join(pipeline, "runs/docedit/v4") },
        });
        console.log(`Open http://localhost:${appPort}. Ctrl+C stops both services.`);
        return;
      }
      await delay(250);
    }
    if (!stopping) { console.error("The pipeline did not become ready."); stop(1); }
  })().catch((error) => { console.error(error); stop(1); });
});
process.exitCode = await done;
