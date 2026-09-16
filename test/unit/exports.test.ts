import { describe, expect, it } from "vitest";

import * as publicApi from "../../src/index.js";

describe("public runtime exports", () => {
    it("exports exactly the approved runtime API", () => {
        expect(Object.keys(publicApi).sort()).toEqual([
            "NoUsableRpcEndpointError",
            "OperationTimeoutError",
            "RpcEndpointDataError",
            "RpcPoolClosedError",
            "RpcPoolManager",
            "UnknownNetworkError",
        ]);
    });
});
