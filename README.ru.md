# ethers-rpc-pool

<p align="center">
  <a href="https://www.npmjs.com/package/@drillcoder/ethers-rpc-pool"><img alt="npm" src="https://img.shields.io/npm/v/%40drillcoder%2Fethers-rpc-pool?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/@drillcoder/ethers-rpc-pool"><img alt="npm downloads" src="https://img.shields.io/npm/dm/%40drillcoder%2Fethers-rpc-pool?style=flat-square"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/npm/l/%40drillcoder%2Fethers-rpc-pool?style=flat-square"></a>
  <a href="https://github.com/drillcoder/ethers-rpc-pool/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/drillcoder/ethers-rpc-pool/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="https://codecov.io/gh/drillcoder/ethers-rpc-pool"><img alt="test coverage" src="https://codecov.io/gh/drillcoder/ethers-rpc-pool/branch/main/graph/badge.svg"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6.x-3178c6?style=flat-square">
  <img alt="ethers" src="https://img.shields.io/badge/ethers-v6-2535a0?style=flat-square">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square">
</p>

[🇬🇧 English](README.md) | 🇷🇺 Русский

Отказоустойчивый пул JSON-RPC endpoint для ethers v6 и Node.js. Он выбирает endpoint для каждой операции, учитывает
latency и нагрузку, повторяет подходящие операции, применяет cooldown после временных сбоев и навсегда исключает
endpoint с неверной авторизацией или chain ID.

## Установка

```sh
npm install @drillcoder/ethers-rpc-pool ethers
```

Требования: Node.js 22 или новее, ethers v6 и ESM.

## Создание пула

```ts runnable
import { RpcPoolManager } from "@drillcoder/ethers-rpc-pool";

const pool = new RpcPoolManager({
    networks: [{
        chainId: 1,
        rpcUrls: ["http://127.0.0.1:8545"],
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

`requestTimeoutMs` ограничивает один HTTP-запрос. `operationTimeoutMs` ограничивает всю операцию, включая проверку
chain ID, выполнение callback, retry, ожидание cooldown и переключение endpoint. Для отдельной операции можно задать
другой общий лимит через `{ timeoutMs }`.

`RpcPoolManager` владеет provider своих endpoint. Когда менеджер больше не нужен, его следует закрыть.

## Операции с retry

`executeWithRetry()` предназначен для callback, который можно безопасно запустить заново с начала. В пределах одной
попытки используется один закреплённый endpoint. После повторяемого сбоя endpoint новая попытка запускается на
пригодном endpoint в пределах исходного deadline операции.

```ts
const account = "0x0000000000000000000000000000000000000000";

const state = await pool.executeWithRetry(
    1,
    async (provider) => {
        const [blockNumber, balance, transactionCount] = await Promise.all([
            provider.getBlockNumber(),
            provider.getBalance(account),
            provider.getTransactionCount(account),
        ]);

        return { balance, blockNumber, transactionCount };
    },
    { timeoutMs: 15_000 },
);
```

Callback получает ethers `JsonRpcProvider` с полным API, включая contract, signer, события и raw JSON-RPC:

```ts
const blockHex = await pool.executeWithRetry(
    1,
    async (provider) => await provider.send("eth_blockNumber", []),
);
```

Единицей retry является весь callback. Побочные эффекты приложения внутри него должны допускать повторение.

Возможность retry определяется по точному объекту ошибки, который вернул управляемый provider. Если перехватить и
повторно выбросить тот же объект, для него продолжат действовать обычные правила retry endpoint:

```ts
await pool.executeWithRetry(1, async (provider) => {
    try {
        return await provider.getBlockNumber();
    } catch (error) {
        throw error;
    }
});
```

Новое доменное исключение прекращает retry, даже если исходная RPC-ошибка указана в `cause`. Вызывающей стороне будет
передан новый объект:

```ts
await pool.executeWithRetry(1, async (provider) => {
    try {
        return await provider.getBlockNumber();
    } catch (error) {
        throw new Error("Не удалось загрузить панель", { cause: error });
    }
});
```

## Однократные операции

`executeOnce()` запускает callback один раз. Используйте его для отправки транзакций и других операций, результат
которых небезопасно воспроизводить автоматически.

```ts
import { Wallet } from "ethers";

const wallet = new Wallet(process.env.PRIVATE_KEY!);

const transaction = await pool.executeOnce(1, async (provider) => {
    const signer = wallet.connect(provider);
    return await signer.sendTransaction({
        to: "0x000000000000000000000000000000000000dEaD",
        value: 1n,
    });
});

console.log(transaction.hash);
```

Если запись дошла до RPC-сервера, а ответ потерялся, операция завершится ошибкой при неизвестном результате в сети.
Перед повторной отправкой проверьте состояние сети или приложения.

## Время жизни provider и listeners

Каждый endpoint имеет один общий `JsonRpcProvider`, которым владеет менеджер. Завершение callback сохраняет provider
и его listeners активными. Подписка, созданная в callback, после его завершения самостоятельно продолжает опрашивать
тот же endpoint. Эти фоновые запросы используют transport request timeout и observability, но не групповой deadline,
резервирование, failover пула или retry callback завершённой операции. Код, добавивший listener, должен сам его
удалить:

```ts
await pool.executeOnce(1, async (provider) => {
    const listener = (blockNumber: number): void => {
        console.log(blockNumber);
    };

    await provider.on("block", listener);
    try {
        return await provider.getBlockNumber();
    } finally {
        await provider.off("block", listener);
    }
});
```

При `executeWithRetry()` весь callback может быть повторно запущен на другом endpoint. Не регистрируйте один listener
повторно либо очищайте его до возможного retry. `off()` и `removeAllListeners()` останавливают подписку после удаления
её последнего listener; `pool.close()` прекращает фоновые опросы, уничтожая providers endpoint.

Вызов `destroy()` или изменение общих настроек provider влияет на всех пользователей provider этого endpoint.
Сохранённый provider при позднем вызове вне execution callback отправляет запрос прямо на закреплённый endpoint. Такой
вызов использует transport timeout и observability, но не участвует в выборе пула, retry, active groups и deadline
предыдущей операции. После `destroy()` или `pool.close()` сохранённый provider отклоняет новые сетевые вызовы локально
с ethers-кодом `UNSUPPORTED_OPERATION`; HTTP-запрос и transport-событие пула не создаются.

Контекст выполнения закрывается вместе с попыткой. Асинхронная работа, унаследовавшая закрытый контекст, не может
начать новый управляемый HTTP-запрос. Эта граница относится к сетевым запросам; уже запущенный JavaScript-код
продолжает выполняться по обычным правилам JavaScript.

## Выбор endpoint

Первичные операции `executeWithRetry()` сначала получают реальный замер latency каждого свободного пригодного
endpoint. Отдельный warmup-запрос для этого не создаётся.

После начальных измерений обычный выбор минимизирует:

```text
latencyEwmaMs × (activeGroups + 1)
```

Точное равенство разрешается round-robin. Cooling, excluded и занятые probe endpoint исключаются до ранжирования.

Каждое двадцатое первичное резервирование `executeWithRetry()` является исследующим. При наличии свободной пригодной
альтернативы выбирается endpoint, который дольше всего не резервировался. Иначе применяется обычный победитель, а
исследующая позиция считается использованной. Retry, ожидание cooldown, начальные измерения и `executeOnce()` не
сдвигают этот счётчик.

Для исследования используется реальная операция вызывающей стороны. Дополнительные callback, HTTP-запросы и фоновые
таймеры не создаются. Алгоритм выбора является эвристикой и не гарантирует конкретную latency, свежесть блока или
время включения транзакции.

## Отмена и ошибки

Оба метода выполнения принимают `AbortSignal`:

```ts
const controller = new AbortController();
const operation = pool.executeWithRetry(
    1,
    async (provider) => await provider.getBlockNumber(),
    { signal: controller.signal },
);

controller.abort(new Error("Операция отменена вызывающей стороной"));
await operation;
```

Пакет экспортирует следующие классы ошибок:

- `UnknownNetworkError` — запрошенный chain ID не настроен.
- `NoUsableRpcEndpointError` — все endpoint сети навсегда исключены.
- `OperationTimeoutError` — истёк общий deadline операции.
- `RpcPoolClosedError` — операция запущена после закрытия менеджера.
- `RpcEndpointDataError` — код приложения отверг структурно корректные, но непригодные данные endpoint.

HTTP- или JSON-RPC-ошибка авторизации навсегда исключает endpoint до закрытия менеджера. Временные transport-сбои
обрабатываются правилами cooldown и recovery. Локальные ошибки callback передаются вызывающей стороне и не меняют
состояние endpoint. Ошибки ethers, включая контрактные ошибки `CALL_EXCEPTION` и revert data, сохраняют исходный
объект и его поля. После cooldown endpoint допускается к единственной проверочной попытке; успешное начальное измерение
или исследующий двадцатый выбор восстанавливает его. `RpcEndpointDataError` намеренно отличается от обычной доменной
ошибки: он явно сообщает о непригодных данных endpoint и применяет отдельную политику cooldown.

Transport принимает только один JSON-RPC 2.0 конверт с совпадающим `id` и ровно одним собственным полем `result` или
`error`. Пустые значения `null`, `false`, `0` и `""` являются допустимыми результатами. Невалидный JSON, чужой `id`,
неоднозначный конверт и некорректная ошибка считаются сбоем `endpoint-data`, а не успешным `undefined`. RPC-происхождение
принадлежит только точному объекту ошибки transport; новая пользовательская обёртка является новой ошибкой без такого
происхождения.

## Snapshot и logger

`getSnapshot()` возвращает неизменяемый срез счётчиков, active groups, состояния endpoint, сроков cooldown и latency
EWMA.

```ts
const snapshot = pool.getSnapshot();

for (const network of snapshot.networks) {
    for (const endpoint of network.endpoints) {
        console.log({
            chainId: network.chainId,
            endpointNumber: endpoint.endpointNumber,
            hostname: endpoint.hostname,
            status: endpoint.status,
            latencyEwmaMs: endpoint.latencyEwmaMs,
        });
    }
}
```

Необязательный logger получает события `request`, `response`, `error`, `switch`, `cooldown` и `recovery`:

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
```

Endpoint определяется тройкой `(chainId, endpointNumber, hostname)`. `hostname` точно равен
`new URL(rpcUrl).hostname`: в него не входят userinfo, порт, path, query и fragment. Поддомены сохраняются и могут
содержать идентификатор аккаунта или внутреннее имя. Logger пула не включает полный URL, тела запросов и ответов или
текст внешней ошибки. Ошибка logger не влияет на выполнение RPC.

## Разработка

- `npm run build` — собрать ESM JavaScript и TypeScript declarations.
- `npm run typecheck` — проверить типы исходного кода и compile-time API-тестов.
- `npm run lint` — запустить ESLint с запретом предупреждений.
- `npm test` — запустить набор тестов Vitest.
- `npm run test:coverage` — запустить тесты с порогом покрытия 100%.
- `npm run pack:test` — проверить установленный npm tarball и исполняемый пример README.
- `npm run quality` — выполнить полную проверку качества.

Каноническая проверка запускается в Docker и не требует установки Node.js или внешнего RPC-сервиса на хосте:

```sh
docker build --tag ethers-rpc-pool-quality .
docker run --rm --network none ethers-rpc-pool-quality
```
