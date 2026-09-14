export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface RuntimeDependencies {
    readonly monotonicNow: () => number;
    readonly epochNow: () => number;
    readonly setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
    readonly clearTimeout: (handle: TimerHandle) => void;
    readonly random: () => number;
}

const systemRuntime: RuntimeDependencies = {
    monotonicNow: () => globalThis.performance.now(),
    epochNow: () => Date.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => {
        globalThis.clearTimeout(handle);
    },
    random: () => Math.random(),
};

export function createRuntime(
    overrides: Partial<RuntimeDependencies> = {},
): RuntimeDependencies {
    return Object.freeze({
        ...systemRuntime,
        ...overrides,
    });
}
