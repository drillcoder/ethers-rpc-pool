# ethers-rpc-pool

[🇬🇧 English](README.md) | 🇷🇺 Русский

Отказоустойчивый пул адресов JSON-RPC на TypeScript для ethers v6 и Node.js. Он балансирует параллельные операции,
охлаждает неисправные endpoint, исключает неверные учётные данные или chain ID и предоставляет безопасную диагностику.

## Установка

```sh
npm install @drillcoder/ethers-rpc-pool ethers
```

Требуются Node.js 22 или новее и ethers v6. Пакет поставляется только как ESM.

## Создание и закрытие пула

`RpcPoolManager` владеет своими provider и таймерами. Всегда закрывайте его, желательно в `finally`:

```ts
import { RpcPoolManager } from "@drillcoder/ethers-rpc-pool";

const pool = new RpcPoolManager({
    networks: [{
        chainId: 1,
        rpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
    }],
    requestTimeoutMs: 10_000,
    operationTimeoutMs: 30_000,
});

try {
    const blockNumber = await pool.executeWithRetry(1, async (client) => await client.getBlockNumber());
    console.log(blockNumber);
} finally {
    await pool.close();
}
```

Если передать `timeoutMs`, он станет общим лимитом времени для этой операции вместо `operationTimeoutMs` из настроек
менеджера. В этот лимит входят проверка endpoint, выполнение callback, повторные попытки и ожидание cooldown.

## Повторяемое чтение

Используйте `executeWithRetry()` для группы запросов только на чтение. На всю попытку закрепляется один endpoint. После
повторяемого сбоя пул может заново запустить callback на другом endpoint в пределах общего deadline операции.

```ts
const account = "0x0000000000000000000000000000000000000000";

const state = await pool.executeWithRetry(
    1,
    async (client) => {
        const [blockNumber, balance, transactionCount] = await Promise.all([
            client.getBlockNumber(),
            client.getBalance(account),
            client.getTransactionCount(account),
        ]);
        return { balance, blockNumber, transactionCount };
    },
    { timeoutMs: 15_000 },
);
```

`RetryableRpcClient` предоставляет полный стандартный API чтения, симуляции, разрешения имён и ожидания,
поддерживаемый пулом:

- `getNetwork()`, `getBlockNumber()`, `getBlock()`
- `getBalance()`, `getTransactionCount()`, `getCode()`, `getStorage()`
- `getFeeData()`, `getLogs()`
- `getTransaction()`, `getTransactionReceipt()`, `getTransactionResult()`
- `call()`, `estimateGas()`
- `resolveName()`, `lookupAddress()`
- `waitForBlock()`, `waitForTransaction()`

В нём намеренно нет отправки транзакций, произвольного JSON-RPC, подписок и методов жизненного цикла.

## Однократная запись

Используйте `executeOnce()` для операций, изменяющих состояние. Его клиент совместим с ethers v6 `JsonRpcProvider`,
включая `broadcastTransaction()`, raw `send()`, события и подключённые signer.

```ts
import { Wallet } from "ethers";

const wallet = new Wallet(process.env.PRIVATE_KEY!);

const transaction = await pool.executeOnce(1, async (client) => {
    const signer = wallet.connect(client);
    return await signer.sendTransaction({
        to: "0x000000000000000000000000000000000000dEaD",
        value: 1n,
    });
});

console.log(transaction.hash);
```

В этом же режиме подписанную транзакцию можно отправить через `client.broadcastTransaction(signedTransaction)`.

## Ошибки

Публичные ошибки являются обычными классами, поэтому для сужения типа используйте `instanceof`:

```ts
import {
    NoUsableRpcEndpointError,
    OperationTimeoutError,
    RpcEndpointDataError,
    RpcPoolClosedError,
    UnknownNetworkError,
} from "@drillcoder/ethers-rpc-pool";

try {
    await pool.executeWithRetry(1, async (client) => {
        const block = await client.getBlock("latest");
        if (block === null) throw new RpcEndpointDataError("Latest block is missing");
        return block;
    });
} catch (error) {
    if (error instanceof UnknownNetworkError) {
        console.error("Сеть не настроена", error.chainId);
    } else if (error instanceof NoUsableRpcEndpointError) {
        console.error("Все endpoint исключены навсегда", error.chainId);
    } else if (error instanceof OperationTimeoutError) {
        console.error("Время операции истекло", error.timeoutMs);
    } else if (error instanceof RpcPoolClosedError) {
        console.error("Пул закрыт");
    } else {
        throw error;
    }
}
```

Выбрасывайте `RpcEndpointDataError`, если endpoint вернул структурно корректные, но непригодные данные. Пул временно
пометит такой endpoint как неисправный.

## Отмена

Оба режима выполнения принимают `AbortSignal`. Если у сигнала задана причина, возвращённый promise отклоняется с ней.

```ts
const controller = new AbortController();
const operation = pool.executeWithRetry(
    1,
    async (client) => await client.waitForBlock(20_000),
    { signal: controller.signal },
);

controller.abort(new Error("Операция отменена вызывающей стороной"));
await operation;
```

## Важные особенности выполнения

- `executeWithRetry()` повторяет весь callback, а не только неудачный RPC-запрос. Поэтому внешние побочные эффекты
  callback могут выполниться несколько раз. Весь callback должен быть идемпотентным.
- После запуска callback метод `executeOnce()` никогда не запускает его повторно. Это предотвращает автоматическую
  повторную запись, но не гарантирует её однократное выполнение.
- Если запись дошла до RPC-сервера, но ответ потерялся, `executeOnce()` вернёт ошибку, хотя запись могла выполниться.
  Результат такой операции неизвестен: перед ручным повтором проверьте состояние сети или приложения.
- Endpoint, вернувший HTTP- или JSON-RPC-ошибку авторизации, остаётся исключённым до конца жизни менеджера. Исправьте
  учётные данные и создайте новый `RpcPoolManager`, чтобы снова использовать этот endpoint.
- Отмена прекращает ожидания и запросы под управлением пула и быстро завершает публичный promise. Она не может
  принудительно остановить синхронный код или другую работу callback, которая не поддерживает отмену. Такой код может
  продолжить работу, но выданный ему клиент уже деактивирован, а итоговое завершение callback будет проигнорировано.
  Блокировка event loop также задерживает обработку отмены.

## Snapshot, logger и метрики

`getSnapshot()` возвращает неизменяемый срез счётчиков запросов, категорий ошибок, активных групп, latency EWMA,
cooldown и состояния endpoint. Идентификаторы endpoint очищены от секретов.

```ts
const snapshot = pool.getSnapshot();
console.log(snapshot.totalRequests, snapshot.errorsByCategory);

for (const network of snapshot.networks) {
    for (const endpoint of network.endpoints) {
        console.log(network.chainId, endpoint.endpointId, endpoint.status, endpoint.latencyEwmaMs);
    }
}
```

Logger получает события `request`, `response`, `error`, `switch`, `cooldown` и `recovery`. Небольшой адаптер может
преобразовать их в метрики без привязки пула к библиотеке мониторинга:

```ts
import { RpcPoolManager, type RpcPoolLoggerEvent } from "@drillcoder/ethers-rpc-pool";

const counters = new Map<string, number>();
const recordMetric = (event: RpcPoolLoggerEvent): void => {
    const key = event.type === "error" ? `rpc.${event.type}.${event.category}` : `rpc.${event.type}`;
    counters.set(key, (counters.get(key) ?? 0) + 1);
};

const monitoredPool = new RpcPoolManager({
    networks: [{ chainId: 1, rpcUrls: ["https://ethereum-rpc.publicnode.com"] }],
    requestTimeoutMs: 10_000,
    operationTimeoutMs: 30_000,
    logger: recordMetric,
});

try {
    await monitoredPool.executeWithRetry(1, async (client) => await client.getBlockNumber());
} finally {
    await monitoredPool.close();
}
```

Ошибки logger изолированы от RPC-операций. Идентификаторы endpoint и поля ошибок очищаются до передачи события.

## Команды разработки

- `npm run build` — собрать ESM JavaScript, declarations, declaration maps и source maps.
- `npm run typecheck` — проверить типы production-кода и compile-time API-тестов без генерации файлов.
- `npm run lint` — запустить ESLint с запретом предупреждений.
- `npm run lint:fix` — применить безопасные исправления ESLint.
- `npm test` — запустить герметичные тесты Vitest.
- `npm run test:coverage` — запустить тесты и проверить 100% покрытия строк, функций, ветвей и выражений.
- `npm run pack:test` — собрать, упаковать, установить и проверить артефакт в чистом ESM-проекте.
- `npm run quality` — запустить полную каноническую проверку качества.

## Полная проверка качества в Docker

Для полной проверки на хосте требуется только Docker. Используются зафиксированные версии Node.js и npm, внешний
RPC-сервис не нужен:

```sh
docker build --tag ethers-rpc-pool-quality .
docker run --rm ethers-rpc-pool-quality
```

Контейнер запускает `npm run quality`: сборку, проверку типов, линтинг, герметичные тесты, 100% покрытия и smoke-тест
упакованного npm-пакета.
