import { JsonRpcProvider } from "ethers";
import type {
  JsonRpcPayload,
  JsonRpcResult,
  Networkish,
} from "ethers";

export type HttpRequest = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export class EndpointJsonRpcProvider extends JsonRpcProvider {
  readonly #request: HttpRequest;
  readonly #url: string;

  public constructor(
    url: string,
    network: Networkish,
    request: HttpRequest = globalThis.fetch,
  ) {
    super(url, network, {
      batchMaxCount: 1,
      staticNetwork: true,
    });

    this.#url = url;
    this.#request = request;
  }

  public override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const payloads = Array.isArray(payload) ? payload : [payload];

    return await Promise.all(
      payloads.map(async (singlePayload) => await this.#sendOne(singlePayload)),
    );
  }

  async #sendOne(payload: JsonRpcPayload): Promise<JsonRpcResult> {
    const response = await this.#request(this.#url, {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    return (await response.json()) as JsonRpcResult;
  }
}
