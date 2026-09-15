import type { Listener, ProviderEvent } from "ethers";

import type { EndpointJsonRpcProvider } from "../transport/provider.js";
import { EndpointReservationUnavailableError } from "./attempt.js";
import type { SingleAttemptRpcClient } from "./types.js";

interface FacadeListener {
    readonly event: ProviderEvent;
    readonly listener: Listener;
}

export interface SingleRpcAttempt {
    readonly client: SingleAttemptRpcClient;
    deactivate(): Promise<void>;
}

export class SingleRpcCallError extends Error {
    public override readonly name = "SingleRpcCallError";

    public constructor(cause: unknown) {
        super("Single-attempt RPC client call failed", { cause });
    }
}

export function createSingleRpcAttempt(
    provider: EndpointJsonRpcProvider,
    isEndpointAvailable: () => boolean = () => true,
): SingleRpcAttempt {
    let active = true;
    const listeners: FacadeListener[] = [];
    let cleanup: Promise<void> | undefined;

    const assertActive = (): void => {
        if (!active) {
            throw new Error("RPC client attempt is no longer active");
        }
    };
    const removeTrackedListener = (event: ProviderEvent, listener: Listener): void => {
        const index = listeners.findIndex((tracked) => tracked.event === event && tracked.listener === listener);
        if (index !== -1) {
            listeners.splice(index, 1);
        }
    };
    const removeTrackedListeners = async (event?: ProviderEvent): Promise<void> => {
        const selected = event === undefined ? [...listeners] : listeners.filter((item) => item.event === event);
        for (const tracked of selected) {
            removeTrackedListener(tracked.event, tracked.listener);
            await provider.off(tracked.event, tracked.listener);
        }
    };
    const deactivate = (): Promise<void> => {
        active = false;
        cleanup ??= removeTrackedListeners();
        return cleanup;
    };
    const handler: ProxyHandler<EndpointJsonRpcProvider> = {
        get: (target, property): unknown => {
            if (property === "provider") {
                return facade;
            }
            if (property === "destroy") {
                return (): void => {
                    void deactivate();
                };
            }
            if (property === "on" || property === "once" || property === "addListener") {
                return async (event: ProviderEvent, listener: Listener): Promise<SingleAttemptRpcClient> => {
                    assertActive();
                    if (property === "once") {
                        await provider.once(event, listener);
                    } else {
                        await provider.on(event, listener);
                    }
                    if (active) {
                        listeners.push({ event, listener });
                    } else {
                        await provider.off(event, listener);
                    }
                    return facade;
                };
            }
            if (property === "off" || property === "removeListener") {
                return async (event: ProviderEvent, listener: Listener): Promise<SingleAttemptRpcClient> => {
                    assertActive();
                    removeTrackedListener(event, listener);
                    await provider.off(event, listener);
                    return facade;
                };
            }
            if (property === "removeAllListeners") {
                return async (event?: ProviderEvent): Promise<SingleAttemptRpcClient> => {
                    assertActive();
                    await removeTrackedListeners(event);
                    return facade;
                };
            }

            const value: unknown = Reflect.get(target, property, target);
            if (typeof value !== "function") {
                return value;
            }

            return (...args: unknown[]): unknown => {
                if (!active) {
                    return Promise.reject(new Error("RPC client attempt is no longer active"));
                }
                if (!isEndpointAvailable()) {
                    return Promise.reject(new EndpointReservationUnavailableError());
                }
                let result: unknown;
                try {
                    result = Reflect.apply(value, target, args);
                } catch (cause: unknown) {
                    throw new SingleRpcCallError(cause);
                }
                if (result instanceof Promise) {
                    return result
                        .then((resolved: unknown) => resolved === target ? facade : resolved)
                        .catch((cause: unknown) => {
                            throw new SingleRpcCallError(cause);
                        });
                }
                return result === target ? facade : result;
            };
        },
    };
    const facade = new Proxy(provider, handler);

    return { client: facade, deactivate };
}
