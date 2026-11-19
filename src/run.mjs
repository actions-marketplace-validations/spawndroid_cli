/**
 * The run lifecycle: upload → create → wait → fixtures → command → report.
 *
 * Every failure path funnels through one teardown so a device is never left
 * billing because the command threw. Exit codes are part of the contract:
 *   0 tests passed, 1 tests failed, 2 infrastructure or setup failed.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { DEVICE_FILE_MAX_BYTES } from "./config.mjs";

export const EXIT_PASSED = 0;
export const EXIT_TESTS_FAILED = 1;
export const EXIT_INFRA = 2;

export class InfraError extends Error {
  constructor(message, { code = null, phase = null, hint = null } = {}) {
    super(message);
    this.name = "InfraError";
    this.code = code;
    this.phase = phase;
    this.hint = hint;
  }
}

/** 429s that are plan limits, not transient capacity: retrying cannot help. */
const PLAN_CODES = new Set([
  "PLAN_RUNNER_LIMIT",
  "PLAN_DEVICE_MINUTES_EXHAUSTED",
  "concurrency",
  "device-minutes",
]);

/**
 * A gateway or host hiccup, not a verdict. A device takes minutes to boot, so
 * one 502/503/504 while the control plane catches up must not fail the run.
 */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

/** Transport failures (status 0) count as transient too. */
function isTransient(error) {
  return error?.status === 0 || TRANSIENT_STATUSES.has(error?.status);
}

export function remediationFor(code) {
  if (!code) return null;
  if (code.startsWith("INSTALL_") || code.startsWith("AAB_")) {
    return "the build failed to install — check minSdk, that it targets arm64, and that the APK is debuggable";
  }
  switch (code) {
    case "DEVICE_BOOT_TIMEOUT":
      return "the device did not boot in time — retry; if it repeats, the host is unhealthy";
    case "IMAGE_MISSING":
      return "the device image is missing on the host — retry later";
    case "BUILD_EXPIRED":
      return "the build expired (Hobby builds expire 7 days after upload) — upload it again";
    case "PLAN_DEVICE_MINUTES_EXHAUSTED":
    case "device-minutes":
      return "monthly device minutes are exhausted — upgrade or wait for the reset";
    case "PLAN_RUNNER_LIMIT":
    case "concurrency":
      return "the plan's runner limit is reached — wait for a running session to end";
    case "free_pool_full":
    case "ci_pool_full":
    case "paid_pool_empty":
    case "paid_pool_full":
    case "paid_pool_max":
    case "paid_pool_unavailable":
      return "no device capacity right now — retry shortly";
    case "DEVICE_NOT_READY":
      return "the device was not ready — fixtures are pushed only after readiness";
    default:
      return null;
  }
}

function toInfra(error) {
  if (error instanceof InfraError) return error;
  return new InfraError(error?.message ?? String(error), {
    code: error?.code ?? error?.legacyCode ?? null,
  });
}

/**
 * The commit a pull request tests. On `pull_request` events GITHUB_SHA is
 * GitHub's temporary merge commit, which matches no commit on the branch, so
 * checks and comparisons would attach to nothing.
 */
function pullRequestHead(env) {
  if (!env.GITHUB_EVENT_PATH) return null;
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    return event.pull_request?.head?.sha ?? null;
  } catch {
    return null;
  }
}

/** Commit, branch and repo link, when the runner is GitHub Actions. */
export function ciCoords(env) {
  const coords = {};
  const commit = pullRequestHead(env) ?? env.GITHUB_SHA;
  if (commit) coords.commit = commit;
  const branch = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;
  if (branch) coords.branch = branch;
  if (env.GITHUB_REPOSITORY) {
    const server = env.GITHUB_SERVER_URL || "https://github.com";
    coords.repoUrl = `${server}/${env.GITHUB_REPOSITORY}`;
  }
  return coords;
}

export function sessionEnv(view, appSlug, sessionId, createView) {
  // The create response nests the package under `app`; the readiness read
  // returns it at the top level — but for CI sessions the host never records
  // it, so `package` there is null. Fall back to what the create call returned.
  const pkg =
    view.app?.package ?? view.package ?? createView?.app?.package ?? null;
  // spawn() would render a null value as the string "null", which is exactly
  // how Appium ends up resolving a launchable activity for the package "null".
  return Object.fromEntries(
    Object.entries({
      SPAWNDROID_WD_URL: view.webdriverUrl,
      SPAWNDROID_UDID: view.device?.serial,
      SPAWNDROID_APP_PACKAGE: pkg,
      SPAWNDROID_APP: appSlug,
      SPAWNDROID_SESSION_ID: sessionId,
    }).filter(([, value]) => value != null),
  );
}

export async function executeRun({
  spec,
  specDir,
  api,
  env = process.env,
  log = (...args) => console.error(...args),
  pollMs = 5000,
  retryDelayMs = 45_000,
  maxAttempts = 3,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  spawnImpl = spawn,
}) {
  let sessionId = null;
  let ended = false;
  const childRef = { current: null };
  const runUrl = (id) => (id ? `${api.baseUrl}/dashboard/runs/${id}` : null);

  const teardown = async (result) => {
    if (!sessionId || ended) return;
    ended = true;
    try {
      await api.endSession(sessionId, result);
    } catch (error) {
      log(`warning: could not close session ${sessionId}: ${error.message}`);
    }
  };

  const forward = (signal) => {
    if (childRef.current) childRef.current.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  try {
    const app = await resolveApp({ spec, specDir, api, log });
    const idempotencyKey = `spawndroid-${randomUUID()}`;
    const fields = {
      artifactId: app.artifactId,
      ...(spec.profile ? { profileId: spec.profile } : {}),
      ...ciCoords(env),
    };

    const started = await createWithCapacityRetry({
      api,
      fields,
      idempotencyKey,
      maxAttempts,
      retryDelayMs,
      sleep,
      log,
    });
    sessionId = started?.sessionId ?? null;
    if (!sessionId) throw new InfraError("the API did not return a session id");
    log(`session ${sessionId}`);
    if (started?.webdriverUrl) log(`device pending — ${started.webdriverUrl}`);

    const view = await waitForReady({
      api,
      sessionId,
      timeoutSeconds: spec.timeout,
      pollMs,
      sleep,
      log,
    });

    await pushFixtures({
      api,
      sessionId,
      fixtures: spec.fixtures,
      specDir,
      log,
    });

    const { code, signal, spawnError } = await runCommand({
      view,
      createView: started,
      appSlug: app.slug,
      sessionId,
      argv: spec.command,
      env,
      cwd: specDir,
      spawnImpl,
      log,
      childRef,
    });

    if (spawnError || signal) {
      const why = spawnError
        ? "the test command could not start"
        : `the test command was interrupted (${signal})`;
      await teardown("failed");
      log(`error: ${why}`);
      return {
        exitCode: EXIT_INFRA,
        sessionId,
        result: "failed",
        runUrl: runUrl(sessionId),
      };
    }

    const result = code === 0 ? "passed" : "failed";
    // Attach before teardown: the report route accepts a POST after the run
    // ends, but a report that lands while the session is still open cannot
    // race a teardown, and a failure here is a warning, never a lost verdict.
    if (spec.report) {
      await attachReport({
        api,
        sessionId,
        reportPath: spec.report,
        specDir,
        log,
      });
    }
    await teardown(result);
    return {
      exitCode: code === 0 ? EXIT_PASSED : EXIT_TESTS_FAILED,
      sessionId,
      result,
      runUrl: runUrl(sessionId),
    };
  } catch (error) {
    const infra = toInfra(error);
    const hint = infra.hint ?? remediationFor(infra.code);
    log(`error: ${infra.message}`);
    if (infra.code) {
      log(`code: ${infra.code}${infra.phase ? ` (phase ${infra.phase})` : ""}`);
    }
    if (hint) log(`hint: ${hint}`);
    await teardown("failed");
    return {
      exitCode: EXIT_INFRA,
      sessionId,
      result: "failed",
      runUrl: runUrl(sessionId),
    };
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
}

async function resolveApp({ spec, specDir, api, log }) {
  const candidate = resolve(specDir, spec.app);
  let isFile = false;
  try {
    isFile = (await stat(candidate)).isFile();
  } catch {
    isFile = false;
  }
  const looksLikePath = /\.apk$/i.test(spec.app) || spec.app.includes("/");
  if (isFile) {
    const uploaded = await api.uploadApk(candidate);
    if (!uploaded?.slug) {
      throw new InfraError("the upload response did not include an app slug");
    }
    log(
      `uploaded ${uploaded.slug}${uploaded.version ? ` v${uploaded.version}` : ""}`,
    );
    return { artifactId: uploaded.slug, slug: uploaded.slug };
  }
  if (looksLikePath) {
    throw new InfraError(`APK not found: ${candidate}`, {
      hint: "build the app before running tests",
    });
  }
  return { artifactId: spec.app, slug: spec.app };
}

async function createWithCapacityRetry({
  api,
  fields,
  idempotencyKey,
  maxAttempts,
  retryDelayMs,
  sleep,
  log,
}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await api.createSession(fields, idempotencyKey);
    } catch (error) {
      const planLimit =
        error?.status === 429 &&
        (PLAN_CODES.has(error.code) || PLAN_CODES.has(error.legacyCode));
      const retryable =
        !planLimit && (error?.status === 429 || isTransient(error));
      if (!retryable) throw toInfra(error);
      if (attempt >= maxAttempts) {
        throw new InfraError(
          `${maxAttempts} attempts failed: ${error.message}`,
          {
            code: error.code ?? error.legacyCode ?? null,
          },
        );
      }
      log(
        `start did not go through (${error.code ?? error.status}); attempt ${attempt}/${maxAttempts}, retrying in ${Math.round(
          retryDelayMs / 1000,
        )}s`,
      );
      await sleep(retryDelayMs);
    }
  }
}

async function waitForReady({
  api,
  sessionId,
  timeoutSeconds,
  pollMs,
  sleep,
  log,
}) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let warned = false;
  for (;;) {
    if (Date.now() > deadline) {
      throw new InfraError(
        `timed out after ${timeoutSeconds}s waiting for the device`,
        {
          hint: "run `spawndroid check`; if the host is slow, raise the spec's timeout",
        },
      );
    }
    let view;
    try {
      view = await api.getSession(sessionId);
    } catch (error) {
      if (isTransient(error)) {
        if (!warned) {
          log(
            `the host is not answering yet (${error.status || "network"}); still waiting`,
          );
          warned = true;
        }
        await sleep(pollMs);
        continue;
      }
      throw toInfra(error);
    }
    if (view?.state === "ready") return view;
    if (view?.state === "failed") {
      throw new InfraError(
        `session failed: ${view.errorCode ?? view.error ?? "unknown"}`,
        {
          code: view.errorCode ?? null,
          phase: view.errorPhase ?? null,
        },
      );
    }
    if (view?.endedAt)
      throw new InfraError("session ended before it became ready");
    await sleep(pollMs);
  }
}

async function pushFixtures({ api, sessionId, fixtures, specDir, log }) {
  for (const fixture of fixtures) {
    const local = resolve(specDir, fixture.local);
    let info;
    try {
      info = await stat(local);
    } catch {
      throw new InfraError(`fixture not found: ${fixture.local}`);
    }
    if (!info.isFile())
      throw new InfraError(`fixture is not a file: ${fixture.local}`);
    if (info.size > DEVICE_FILE_MAX_BYTES) {
      throw new InfraError(
        `fixture ${fixture.local} is larger than the 32 MB limit`,
      );
    }
    const filename = basename(local);
    const presigned = await api.presignFile(sessionId, {
      filename,
      path: fixture.device,
      size: info.size,
    });
    const bytes = await readFile(local);
    await api.putFile(presigned.url, bytes, presigned.contentType);
    await api.commitFile(sessionId, {
      key: presigned.key,
      path: fixture.device,
      filename,
    });
    log(`pushed ${fixture.local} → ${fixture.device}/${filename}`);
  }
}

function runCommand({
  view,
  createView,
  appSlug,
  sessionId,
  argv,
  env,
  cwd,
  spawnImpl,
  log,
  childRef,
}) {
  return new Promise((done) => {
    const child = spawnImpl(argv[0], argv.slice(1), {
      stdio: "inherit",
      // The suite runs from the directory the spec lives in, so `./gradlew`
      // and relative report paths resolve even when `--config` points elsewhere.
      cwd,
      env: { ...env, ...sessionEnv(view, appSlug, sessionId, createView) },
    });
    childRef.current = child;
    child.on("error", (error) => {
      log(`could not start the test command: ${error.message}`);
      childRef.current = null;
      done({ code: null, signal: null, spawnError: true });
    });
    child.on("exit", (code, signal) => {
      childRef.current = null;
      done({ code, signal, spawnError: false });
    });
  });
}

async function attachReport({ api, sessionId, reportPath, specDir, log }) {
  const file = resolve(specDir, reportPath);
  let xml;
  try {
    xml = await readFile(file, "utf8");
  } catch {
    log(`warning: no JUnit report at ${reportPath} — attach skipped`);
    return;
  }
  try {
    await api.postReport(sessionId, xml);
    log(`attached ${reportPath}`);
  } catch (error) {
    log(`warning: could not attach ${reportPath}: ${error.message}`);
  }
}
