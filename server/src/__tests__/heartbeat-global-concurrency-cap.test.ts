import { describe, expect, it } from "vitest";
import {
  GLOBAL_MAX_CONCURRENT_RUNS_CLAMP_MAX,
  resolveGlobalMaxConcurrentRuns,
} from "../services/heartbeat.ts";

// GOL-1506 (GOL-557 lever 1): fleet-wide run-concurrency cap resolver.
describe("resolveGlobalMaxConcurrentRuns", () => {
  it("returns null (gate disabled) when the env var is unset", () => {
    expect(resolveGlobalMaxConcurrentRuns({})).toBeNull();
  });

  it("returns null for empty / whitespace values", () => {
    expect(resolveGlobalMaxConcurrentRuns({ PAPERCLIP_MAX_CONCURRENT_RUNS: "" })).toBeNull();
    expect(resolveGlobalMaxConcurrentRuns({ PAPERCLIP_MAX_CONCURRENT_RUNS: "   " })).toBeNull();
  });

  it("returns null for non-numeric or non-positive values (fail open, never trap the fleet at 0)", () => {
    expect(resolveGlobalMaxConcurrentRuns({ PAPERCLIP_MAX_CONCURRENT_RUNS: "abc" })).toBeNull();
    expect(resolveGlobalMaxConcurrentRuns({ PAPERCLIP_MAX_CONCURRENT_RUNS: "0" })).toBeNull();
    expect(resolveGlobalMaxConcurrentRuns({ PAPERCLIP_MAX_CONCURRENT_RUNS: "-3" })).toBeNull();
  });

  it("parses a valid positive cap (the deployed 4-5 range)", () => {
    expect(resolveGlobalMaxConcurrentRuns({ PAPERCLIP_MAX_CONCURRENT_RUNS: "4" })).toBe(4);
    expect(resolveGlobalMaxConcurrentRuns({ PAPERCLIP_MAX_CONCURRENT_RUNS: "5" })).toBe(5);
  });

  it("floors fractional values", () => {
    expect(resolveGlobalMaxConcurrentRuns({ PAPERCLIP_MAX_CONCURRENT_RUNS: "5.9" })).toBe(5);
  });

  it("clamps absurdly large values to the safety ceiling", () => {
    expect(resolveGlobalMaxConcurrentRuns({ PAPERCLIP_MAX_CONCURRENT_RUNS: "100000" })).toBe(
      GLOBAL_MAX_CONCURRENT_RUNS_CLAMP_MAX,
    );
  });
});
