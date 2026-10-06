import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  listProcessGroupLeftovers,
  resetLeftoverProcessGroupSweeps,
  sweepLeftoverProcessGroup,
  type LeftoverProcessGroupEvent,
} from "./leftover-process-group.js";

// These tests spawn real processes: the leak only reproduces with a real
// detached process group and a real descendant that outlives its leader.
const linux = process.platform === "linux";

function procState(pid: number): string | null {
  try {
    const line = readFileSync(`/proc/${pid}/stat`, "utf8");
    return line.slice(line.lastIndexOf(") ") + 2).trim().split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}

/** A SIGKILLed descendant becomes a ZOMBIE, and `kill(pid, 0)` succeeds on a
 *  zombie — so "gone" has to mean "no longer running", read from /proc. */
function isRunning(pid: number) {
  const state = procState(pid);
  return state !== null && state !== "Z";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntilNotRunning(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) return true;
    await sleep(50);
  }
  return !isRunning(pid);
}

/** Spawn a run leader the same way `runChildProcess` does (detached, so it leads
 *  its own process group) with a descendant that outlives it. Resolves once the
 *  leader has closed, i.e. at the moment the run-exit sweep would fire. */
async function startRunWithOutlivingDescendant(script: string) {
  const child = spawn("bash", ["-c", script], {
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const leaderPid = child.pid as number;
  let stdout = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  const descendantPid = Number(stdout.trim());
  expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
  return { leaderPid, processGroupId: leaderPid, descendantPid };
}

const OUTLIVES = "sleep 30 </dev/null >/dev/null 2>&1 & echo $!; exit 0";
const OUTLIVES_IGNORING_SIGTERM = "trap '' TERM; sleep 30 </dev/null >/dev/null 2>&1 & echo $!; exit 0";

afterEach(() => {
  resetLeftoverProcessGroupSweeps();
});

describe.runIf(linux)("sweepLeftoverProcessGroup", () => {
  it("terminates a descendant that outlived its run leader", async () => {
    const run = await startRunWithOutlivingDescendant(OUTLIVES);
    await sleep(200);
    // Baseline: without a sweep this process is the leak — it is still running
    // after the run ended, and still in the run's process group.
    expect(isRunning(run.descendantPid)).toBe(true);
    expect(listProcessGroupLeftovers(run.processGroupId)).toContain(run.descendantPid);

    const events: LeftoverProcessGroupEvent[] = [];
    sweepLeftoverProcessGroup({
      runId: "run-1",
      processGroupId: run.processGroupId,
      leaderPid: run.leaderPid,
      graceSec: 2,
      onLeftover: (event) => events.push(event),
    });

    expect(await waitUntilNotRunning(run.descendantPid, 5_000)).toBe(true);
    expect(events.map((event) => event.signal)).toEqual(["SIGTERM"]);
    expect(events[0]?.leftoverPids).toContain(run.descendantPid);
  }, 15_000);

  it("escalates to SIGKILL when the leftover ignores SIGTERM", async () => {
    const run = await startRunWithOutlivingDescendant(OUTLIVES_IGNORING_SIGTERM);
    await sleep(200);
    const events: LeftoverProcessGroupEvent[] = [];
    sweepLeftoverProcessGroup({
      runId: "run-2",
      processGroupId: run.processGroupId,
      leaderPid: run.leaderPid,
      graceSec: 1,
      onLeftover: (event) => events.push(event),
    });
    expect(await waitUntilNotRunning(run.descendantPid, 6_000)).toBe(true);
    expect(events.map((event) => event.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  }, 15_000);

  it("is idempotent: repeated calls for one run arm a single escalation", async () => {
    const run = await startRunWithOutlivingDescendant(OUTLIVES_IGNORING_SIGTERM);
    await sleep(200);
    const events: LeftoverProcessGroupEvent[] = [];
    const input = {
      runId: "run-3",
      processGroupId: run.processGroupId,
      leaderPid: run.leaderPid,
      graceSec: 1,
      onLeftover: (event: LeftoverProcessGroupEvent) => events.push(event),
    };
    sweepLeftoverProcessGroup(input);
    sweepLeftoverProcessGroup(input);
    sweepLeftoverProcessGroup(input);
    expect(events.filter((event) => event.signal === "SIGTERM")).toHaveLength(1);
    expect(await waitUntilNotRunning(run.descendantPid, 6_000)).toBe(true);
    expect(events.filter((event) => event.signal === "SIGKILL")).toHaveLength(1);
  }, 15_000);

  it("sends nothing when the run left an empty process group", async () => {
    const child = spawn("bash", ["-c", "true"], { detached: true, shell: false, stdio: "ignore" });
    const leaderPid = child.pid as number;
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    const events: LeftoverProcessGroupEvent[] = [];
    sweepLeftoverProcessGroup({
      runId: "run-4",
      processGroupId: leaderPid,
      leaderPid,
      graceSec: 5,
      onLeftover: (event) => events.push(event),
    });
    expect(events).toEqual([]);
  }, 10_000);

  it("sends nothing when the group holds only zombies", async () => {
    // A descendant that exits on its own reparents to PID 1 and, with no reaper
    // there, stays a zombie inside the run's process group. `kill(-pgid, 0)`
    // still succeeds on that group, so a naive liveness probe would signal a
    // perfectly clean run on every single exit.
    const run = await startRunWithOutlivingDescendant(
      "sleep 0.2 </dev/null >/dev/null 2>&1 & echo $!; exit 0",
    );
    expect(await waitUntilNotRunning(run.descendantPid, 5_000)).toBe(true);

    let cheapProbeSeesGroup = true;
    try {
      process.kill(-run.processGroupId, 0);
    } catch {
      cheapProbeSeesGroup = false;
    }
    if (cheapProbeSeesGroup) {
      // Precondition for this test to be meaningful: the cheap probe is fooled.
      expect(procState(run.descendantPid)).toBe("Z");
    }
    expect(listProcessGroupLeftovers(run.processGroupId)).toEqual([]);

    const events: LeftoverProcessGroupEvent[] = [];
    sweepLeftoverProcessGroup({
      runId: "run-5",
      processGroupId: run.processGroupId,
      leaderPid: run.leaderPid,
      graceSec: 5,
      onLeftover: (event) => events.push(event),
    });
    expect(events).toEqual([]);
  }, 15_000);

  it("refuses to signal a group this run does not lead", async () => {
    const events: LeftoverProcessGroupEvent[] = [];
    const ownProcessGroupId = Number(
      readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ")[1]?.trim().split(/\s+/)[2],
    );
    expect(ownProcessGroupId).toBeGreaterThan(0);
    // Our own group is definitely alive, so a broken ownership guard would
    // signal the test runner itself.
    sweepLeftoverProcessGroup({
      runId: "run-6",
      processGroupId: ownProcessGroupId,
      leaderPid: ownProcessGroupId + 1,
      graceSec: 1,
      onLeftover: (event) => events.push(event),
    });
    expect(events).toEqual([]);
  });

  it("ignores missing or non-positive process group ids", () => {
    const events: LeftoverProcessGroupEvent[] = [];
    const onLeftover = (event: LeftoverProcessGroupEvent) => events.push(event);
    for (const processGroupId of [null, undefined, 0, -1, 1.5, Number.NaN]) {
      sweepLeftoverProcessGroup({
        runId: `run-guard-${String(processGroupId)}`,
        processGroupId: processGroupId as number | null,
        leaderPid: processGroupId as number | null,
        graceSec: 1,
        onLeftover,
      });
    }
    expect(events).toEqual([]);
    expect(listProcessGroupLeftovers(0)).toEqual([]);
    expect(listProcessGroupLeftovers(-1)).toEqual([]);
  });
});
