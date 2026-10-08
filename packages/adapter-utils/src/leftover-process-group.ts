// Leftover-descendant sweep for finished child-process runs (AgenticOS GOL-3005).
//
// Every run child is spawned with `detached: true` (see `runChildProcess`), so it
// leads its own process group and its whole tree can be signalled as a unit. The
// timeout and cancel paths already signal the group. The NORMAL exit path did
// not: when the run leader closed we only dropped the in-memory handle, so any
// descendant that outlived the leader stayed alive indefinitely. Headless Chrome
// is the usual offender (~160 threads and hundreds of MB per instance), and in a
// pid-capped container each survivor permanently consumes part of the budget.
//
// This is a different leak from unreaped *exited* children. A container init
// reaper (docker `init: true`) clears zombies; it cannot touch the living. The
// two fixes compose, and the ordering matters: SIGKILLing a leftover turns it
// into a zombie, so without a reaper as PID 1 the pid is still held. Pair this
// with the init reaper to get the pid budget back as well as the RAM/threads.
//
// A process that must deliberately outlive its run (for example the sandbox
// callback bridge, which a short start command launches in the background) has
// to leave the run's process group, e.g. with `setsid`. Anything still running
// in the group when the run exits is treated as leaked and terminated.
//
// Safety against pgid reuse: the process-group id is always the leader's pid, and
// Linux will not recycle a pid while it is still in use as the pgid of a
// non-empty process group. So once the leader has been reaped, `kill(-pgid, …)`
// either fails with ESRCH (the group is already empty) or hits exactly this run's
// leftovers. It can never reach an unrelated process group.

import { readFileSync, readdirSync } from "node:fs";

export type LeftoverProcessGroupSignal = "SIGTERM" | "SIGKILL";

export type LeftoverProcessGroupEvent = {
  runId: string;
  processGroupId: number;
  signal: LeftoverProcessGroupSignal;
  /** Pids still alive in the group when the signal was sent (Linux only). */
  leftoverPids: number[];
};

export type SweepLeftoverProcessGroupInput = {
  runId: string;
  /** Process group id recorded at spawn time (always the leader pid, or null). */
  processGroupId: number | null | undefined;
  /** Leader pid, used to assert this run owns the group before signalling it. */
  leaderPid: number | null | undefined;
  /** Seconds to wait after SIGTERM before escalating to SIGKILL. */
  graceSec: number;
  /** Called once per signal actually sent, for logging. */
  onLeftover?: (event: LeftoverProcessGroupEvent) => void;
};

/** Upper bound on the SIGTERM->SIGKILL grace, so a large adapter `graceSec`
 *  cannot park a leaked Chrome tree in the pid budget for minutes after its
 *  run already ended. */
export const LEFTOVER_SWEEP_MAX_GRACE_SEC = 10;

/** Runs with a sweep in flight, keyed by runId (unique per run), so a double
 *  `close`/`error` cannot arm two escalation timers for the same run. */
const inFlightSweeps = new Map<string, NodeJS.Timeout>();

/** `/proc/<pid>/stat` is "<pid> (<comm>) <state> <ppid> <pgrp> …". `comm` can
 *  contain spaces and parens ("chrome (renderer)"), so split on the LAST ")". */
function readProcStatFields(pid: number): { state: string; pgrp: number } | null {
  let line: string;
  try {
    line = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null; // exited between readdir and read
  }
  const close = line.lastIndexOf(") ");
  if (close < 0) return null;
  const fields = line.slice(close + 2).trim().split(/\s+/);
  const state = fields[0];
  const pgrp = Number(fields[2]);
  if (!state || !Number.isInteger(pgrp)) return null;
  return { state, pgrp };
}

/**
 * Pids in the group that are still running. Zombies are excluded on purpose: a
 * zombie cannot be signalled and only an init reaper clears it, so counting one
 * as "leftover" would make every clean run send pointless signals and log a
 * leak that is not there.
 *
 * Returns null where /proc is unavailable (non-Linux), meaning "unknown".
 */
export function listLiveProcessGroupMembers(processGroupId: number): number[] | null {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  const live: number[] = [];
  for (const entry of entries) {
    if (entry.length === 0 || entry.charCodeAt(0) < 48 || entry.charCodeAt(0) > 57) continue;
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const stat = readProcStatFields(pid);
    if (!stat || stat.pgrp !== processGroupId) continue;
    if (stat.state === "Z") continue;
    live.push(pid);
  }
  return live;
}

/**
 * True when at least one process is still RUNNING in the group. Cheap gate
 * first (`kill(-pgid, 0)`): on a fully-empty group that is a single syscall and
 * the /proc scan is skipped entirely, which is the normal case.
 */
export function listProcessGroupLeftovers(processGroupId: number): number[] {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return [];
  try {
    process.kill(-processGroupId, 0);
  } catch (error) {
    // ESRCH: nothing at all (not even a zombie) remains. EPERM: a member exists
    // that we may not signal — still worth the precise scan below.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EPERM") return [];
  }
  const live = listLiveProcessGroupMembers(processGroupId);
  // No /proc: fall back to the cheap gate's answer, which said "something here".
  return live ?? [processGroupId];
}

/**
 * Terminate anything left running in a finished run's process group: SIGTERM
 * now, then SIGKILL after a bounded grace. No-op when nothing is still running,
 * which is the normal case for a well-behaved run.
 *
 * Idempotent and safe to call from every run-exit path (success, failure,
 * timeout, cancel, spawn error).
 */
export function sweepLeftoverProcessGroup(input: SweepLeftoverProcessGroupInput): void {
  if (process.platform === "win32") return;

  const processGroupId = input.processGroupId;
  if (typeof processGroupId !== "number" || !Number.isInteger(processGroupId) || processGroupId <= 0) {
    return;
  }

  // Only ever signal a group this run leads. `runChildProcess` derives the pgid
  // from the leader pid, so a mismatch means the record is not ours to signal.
  const leaderPid = input.leaderPid;
  if (typeof leaderPid === "number" && leaderPid > 0 && leaderPid !== processGroupId) return;

  if (inFlightSweeps.has(input.runId)) return;

  const leftoverPids = listProcessGroupLeftovers(processGroupId);
  if (leftoverPids.length === 0) return;

  input.onLeftover?.({ runId: input.runId, processGroupId, signal: "SIGTERM", leftoverPids });
  try {
    process.kill(-processGroupId, "SIGTERM");
  } catch {
    return; // raced to empty between the probe and the signal
  }

  const graceSec = Number.isFinite(input.graceSec) ? input.graceSec : 0;
  const graceMs = Math.min(Math.max(graceSec, 1), LEFTOVER_SWEEP_MAX_GRACE_SEC) * 1000;

  const timer = setTimeout(() => {
    inFlightSweeps.delete(input.runId);
    const stillRunning = listProcessGroupLeftovers(processGroupId);
    if (stillRunning.length === 0) return;
    input.onLeftover?.({ runId: input.runId, processGroupId, signal: "SIGKILL", leftoverPids: stillRunning });
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {
      // Exited during the grace window.
    }
  }, graceMs);
  // Never hold the event loop open on a sweep.
  timer.unref?.();
  inFlightSweeps.set(input.runId, timer);
}

/** Test seam: drop any pending escalation timers. */
export function resetLeftoverProcessGroupSweeps(): void {
  for (const timer of inFlightSweeps.values()) clearTimeout(timer);
  inFlightSweeps.clear();
}
