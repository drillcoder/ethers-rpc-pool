import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntime } from "../../src/pool/runtime.js";
import type {
  RuntimeDependencies,
  TimerHandle,
} from "../../src/pool/runtime.js";

describe("createRuntime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the system clock, timers, and random source by default", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));

    const runtime = createRuntime();
    const cancelledCallback = vi.fn();
    const cancelledTimer = runtime.setTimeout(cancelledCallback, 10);
    runtime.clearTimeout(cancelledTimer);

    const callback = vi.fn();
    runtime.setTimeout(callback, 10);
    vi.advanceTimersByTime(10);

    expect(runtime.epochNow()).toBe(Date.now());
    expect(Number.isFinite(runtime.monotonicNow())).toBe(true);
    expect(runtime.random()).toBeGreaterThanOrEqual(0);
    expect(runtime.random()).toBeLessThan(1);
    expect(cancelledCallback).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledOnce();
    expect(Object.isFrozen(runtime)).toBe(true);
  });

  it("replaces each nondeterministic dependency independently", () => {
    const timerHandle = {} as TimerHandle;
    const injected: RuntimeDependencies = {
      monotonicNow: () => 12.5,
      epochNow: () => 1_767_322_800_000,
      setTimeout: vi.fn(() => timerHandle),
      clearTimeout: vi.fn(),
      random: () => 0.25,
    };

    const runtime = createRuntime(injected);

    expect(runtime).not.toBe(injected);
    expect(runtime.monotonicNow()).toBe(12.5);
    expect(runtime.epochNow()).toBe(1_767_322_800_000);
    expect(runtime.random()).toBe(0.25);
    expect(runtime.setTimeout(() => undefined, 50)).toBe(timerHandle);
    runtime.clearTimeout(timerHandle);
    expect(injected.setTimeout).toHaveBeenCalledOnce();
    expect(injected.clearTimeout).toHaveBeenCalledWith(timerHandle);
  });
});
