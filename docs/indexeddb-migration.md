# 存储层改造方案：chrome.storage.local → IndexedDB

> 状态：**已实施并真机验证通过**（1.1.0，1.0.4 覆盖安装后功能正常）
> 目标版本：1.1.0
> 适用范围：`src/logic/storage.ts` 覆盖的全部数据（AI 配置、简历、提示词、岗位账本）
> 决策记录见 §9（A–F 均已拍板）
> **迁移相关的过渡代码要删什么、什么时候删** → [`docs/transitional-code.md`](./transitional-code.md)
>
> 真机暴露的两个问题（都已修，教训记在 §6 与 §5.3）：
> 1. 消息层的契约是「处理器必须返回非 undefined」，否则调用方按「没有响应」抛错；
> 2. `runtime.sendMessage` **不投递给发送者自身** —— 所以「页面 → 后台 → 转发」那条链路
>    在**后台自己写数据**时无人应答。最终改成写入方直接广播，那一跳整个删掉。

---

## 1. 为什么做这件事

现在的存储层是「**一个键装一整张表**」：账本 = 单个键 `offer-hunter-records`，值是整张 Map。由此派生出四个问题：

| 问题 | 现状（有据可查） |
| --- | --- |
| 写放大 | `upsertRecord` = 读整表 → 改一条 → **写整表**（`storage.ts:290-296`），每次点分析/生成都要序列化并重写 1–3MB |
| 并发丢写 | 因为是读-改-写，被迫用 `serializeLedgerWrite` 串行化（`storage.ts:251-264`）；而且它**只锁单个 JS 上下文**，不是跨上下文锁 |
| 淘汰昂贵 | 超限时全表排序再删（`storage.ts:275-288`） |
| 天花板 | Chrome 114 起 `storage.local` 约 10MB，且**写满的表现是静默失败**（`storage.ts:266-272` 的注释自己写明了） |

IndexedDB 能一次性解掉这四条：**一条记录一次写**、**索引 + 游标淘汰**、**配额变成磁盘配额级别**、**事务天然解决并发**（可删掉 `serializeLedgerWrite`）。既然要动，就把四类数据一起搬过去 —— 只搬账本会留下两套存储与两套心智模型，反而更乱。

**顺带的收益**：账本不再需要「整表进内存」，侧边栏可以按当前岗位只读一条记录。

---

## 2. 目标与边界

**目标**

1. 四类数据全部落到扩展自己的 IndexedDB；`chrome.storage.local` 只作为**一次性迁移的数据源**存在。
2. 封装出一层 IDB 工具：调用方看不到 `IDBRequest` / `IDBTransaction`，且对 SW 被回收、连接被关、事务被中止这类事有明确对策。
3. `src/logic/storage.ts` 的**对外函数名与语义基本不变**，调用方改动收敛到两处 import 与一处行为改进（见 §8）。
4. 老的 `chrome.storage.local` 数据**一条不丢**地迁过来：迁移原子、幂等、可重试、可核对。

**非目标（本次不做）**

- 不做加密。IDB 与 `storage.local` 一样是明文，现状与隐私政策都按明文描述。
- 不改数据结构（`AiSettings` / `Resume` / `PromptSettings` / `JobRecord` 形状不变），只改存放方式。`JobRecord` 的扁平形状由 `mergeDefaults` 的裁剪规则决定（`types.ts:270-277`），本次不动。
- 不改 AI 调用路径、不改站点适配器、内容脚本永不碰 IDB。
- **不引入运行时依赖**（不用 `idb` / `dexie`）。我们需要的 API 面很小（见 §5.1），自己写一层比引入依赖更可控，也免得为它维护版本。

---

## 3. 事实基础（改造前必须成立的前提）

改造前已核对的既有行为，改造后必须继续成立：

| 行为 | 位置 | 改造后的对应物 |
| --- | --- | --- |
| 字段补齐 / 裁剪（缺字段不炸、已删字段不留） | `mergeDefaults`（`storage.ts:87-116`） | 原样复用，读时执行 |
| 动态键映射（账本）免裁剪的豁免 | `Object.keys(fallback).length === 0`（`:100-102`） | 原样保留（这是账本能用 `mergeDefaults` 的前提） |
| 历史 JSON 字符串复活 | `reviveLegacyString`（`:57-69`） | 原样复用（迁移时也要走一遍） |
| `resume.gist` → `sources.gist`、`syncedFrom` → `syncedKey` | `migrateResumeShape`（`:182-215`） | 原样复用 |
| 每个来源必须有完整配置形状 | `ensureSourceConfigs`（`:156-165`） | 原样复用 |
| 账本键 `abc123` → `boss:abc123` | `migrateRecordKeys`（`:434-468`） | 迁移时执行一次 |
| 抹掉已删字段 `status` | `stripRemovedRecordFields`（`:408-418`） | 迁移时执行一次 |
| 账本上限 2000、超出丢最旧 | `MAX_RECORDS`（`:273`） | 改为按 `firstSeen` 索引游标淘汰 |
| 写入去抖 400ms + 关页补落盘 | `WRITE_DEBOUNCE_MS`（`:303`）、`pagehide`（`:382-383`） | 保持不变 |
| 设置页改了，面板立即反映 | `storage.onChanged`（`:374-379`） | **需替换**，见 §6 |
| 清空数据 = 删四键 + 重建默认值 | `resetAllStorage`（`:544-548`） | 改为清空 IDB 仓库 + 重建默认值 + 删遗留键 |

### 3.1 三个必须先知道的现状问题（会顺手修掉）

1. **`STORAGE_KEYS` 不是内部唯一真相**：它只在页面侧用，而 `ensureStorageDefaults`（`:483`）与 `resetAllStorage`（`:546`）各自**硬编码**了同样四个键名。今天加一个存储键要改三处，很容易漏，漏了的表现是「清空数据没清干净」。
2. **`useStoredValue` 故意忽略「删除」事件**（`:376` 要求 `newValue !== undefined`）。所以「清空全部数据」后界面必须刷新才生效（这也是 `Options.vue:478-480` 那句提示的由来）。
3. **初始化没有门闸**：`ensureStorageDefaults()` 在 SW 顶层 fire-and-forget（`background/main.ts:53-55`），消息处理器随时可能在迁移的 `get`→`set` 窗口里跑。现在靠「读的时候顺便归一」兜住（`readRecords` 里的 `migrateRecordKeys`，`:241-246`），能用但很脆。

---

## 4. 目标结构

### 4.1 库与仓库

数据库名 `offer-hunter`（**稳定不变，改名等于丢数据**），`DB_VERSION = 1`。

```
offer-hunter (IndexedDB)
├── settings    keyPath: 'id'                      // 单文档仓库
│     { id: 'ai' | 'resume' | 'prompts', value: <域对象>, updatedAt: ISO }
├── records     keyPath: 'key'                     // 岗位账本，一条一条存
│     { key: 'boss:<securityId>', siteId, naturalKey, title, company,
│       recruiterName, salary, match, greeting, error, firstSeen }
│     索引 by-firstSeen → firstSeen   （淘汰：升序游标）
│     索引 by-siteId    → siteId      （为将来「投递记录面板」按站点筛选）
└── meta        keyPath: 'key'                     // 迁移与自检记录
      { key: 'schema',    value: { version: 1, createdAt } }
      { key: 'migration', value: { from: 'chrome.storage.local', state: 'done', at, counts } }
```

**为什么 `settings` 用统一仓库而不是三个仓库**：三者语义完全相同（读一个文档 → 补默认值 → 写回），统一仓库让「清空」「未来加一类设置」都是一行。`id` 顺便把「存储键名」这件事收进一处：**页面的 `useStoredValue` 改为传 `'ai' | 'resume' | 'prompts'`**，四个 legacy chrome 键名从此只出现在迁移模块里 —— 直接解掉 §3.1 的第 1 条。

**为什么 `records` 的 keyPath 用 `key` 字符串而不是复合键 `['siteId','naturalKey']`**：`recordKey()` 的 `siteId:naturalKey` 是既有约定，`migrateRecordKeys` 也按它判断是否迁过（`:446-451`）；复合键会让缺 `siteId` 的存量脏数据直接写不进去，还得反向解析字符串。保持字符串键 = 迁移逻辑零改动、风险最低。

### 4.2 文件划分

机制与策略分开：`platform/` 只懂 IndexedDB，`logic/store/` 只懂 Offer Hunter。

```
src/platform/idb/
  database.ts     // 通用机制：openDb 单例、连接生命周期、runTx、请求 promise 化、重试
  schema.ts       // 本项目的 schema 声明 + 分版本 upgrade 块
  __tests__/
src/logic/store/
  migrations.ts   // 现有的纯迁移函数（从 storage.ts 搬出，测试跟着搬）
  records.ts      // 账本领域操作：getOne / upsert / getAll / prune / clear
  settings.ts     // 三个单文档的读写（默认值 + mergeDefaults）
  cache.ts        // 每上下文的内存 memo（写穿 + 有界 + 事件失效），见 §13
  events.ts       // 跨上下文变更广播（替代 storage.onChanged）
  legacy.ts       // chrome.storage.local → IDB 一次性迁移（原子 / 幂等 / 校验后删旧键）
  ready.ts        // 初始化门闸：ensureStoreReady()，所有读写先 await 它
  useStoredValue.ts
  __tests__/
src/logic/storage.ts  // 唯一门面：导出名与语义保持原样
```

`src/logic/storage.ts` 继续导出 `readAiSettings` / `writeAiSettings` / `readResume` / `writeResume` / `readPromptSettings` / `writePromptSettings` / `readRecords` / `upsertRecord` / `resetAllStorage` / `ensureStorageDefaults` / `mergeDefaults` 等，内部改为委托 `logic/store/*`。这样 `background/main.ts` 与 `sidepanel/state.ts` 的调用点**一行都不用改**，评审 diff 集中在存储层。

> 已核对、不成立的优化：`storage.ts` 顶层 `import { ref, watch } from 'vue'`，一度担心会把 Vue 打进 SW 包。实测构建产物 `extension/dist/background/index.mjs`（51KB）里没有 `createElementBlock` / `effectScope` / `onScopeDispose` 任何一个 —— `useStoredValue` 在 SW 侧没有调用者，已被 tree-shaking 整段去掉。**因此不需要为了包体积把组合式函数拆出去**，拆分只为清晰。

---

## 5. IDB 封装设计（优雅 + 高可用）

### 5.1 对外 API：业务代码只看到这几个

```ts
// 单条 / 批量
function get<T>(store: StoreName, key: IDBValidKey, tx?: TxContext): Promise<T | undefined>
function getAll<T>(store: StoreName, tx?: TxContext): Promise<T[]>
function put<T>(store: StoreName, value: T, tx?: TxContext): Promise<void>
function putMany<T>(store: StoreName, values: T[], tx?: TxContext): Promise<void>
function del(store: StoreName, key: IDBValidKey, tx?: TxContext): Promise<void>
function count(store: StoreName, tx?: TxContext): Promise<number>
function clearStore(store: StoreName, tx?: TxContext): Promise<void>

// 需要原子性时（迁移、清空、淘汰）
function runTx<T>(
  stores: StoreName[],
  mode: 'readonly' | 'readwrite',
  fn: (tx: TxContext) => Promise<T> | T,
): Promise<T>

// 需要游标时（按 firstSeen 淘汰、将来的分页与统计）
interface IterateOptions {
  index?: string
  range?: IDBKeyRange
  direction?: IDBCursorDirection
  limit?: number
}
function iterate<T>(
  store: StoreName,
  options: IterateOptions,
  cb: (value: T) => void,
  tx?: TxContext,
): Promise<void>
```

- 每个原语都带**可选 `tx` 尾参**：不传就自己开一个短事务（调用最省事），传了就加入调用方的事务（可组合、可原子）。这是「简单调用保持简单、复杂调用能保证原子」的最小代价方案。
- 事务内**禁止 await 非 IDB 的 promise**：IDB 事务在微任务队列排空后自动提交，跨网络/消息的 await 会让事务先关掉，之后所有请求抛 `TransactionInactiveError`。这条写在 `database.ts` 头部，并配正反例 —— 这是 IDB 最容易踩、症状最诡异的坑。
- 写事务的错误必须**同时**监听 `request.onerror` 与 `tx.onabort`：只等 request 会漏掉「后续某个请求失败导致整个事务回滚」的情况。

### 5.2 内存层（写穿缓存）

IDB 之上还有一层**每上下文的内存 memo**：三个单文档不限量、账本条目 LRU 32 条。它是读的第一站，但**不是真相**——随时可丢，丢了只是多读一次 IDB。设计、规矩与失效细节见 §13。

### 5.3 高可用的六条具体对策

| 风险 | 对策 |
| --- | --- |
| SW 被回收，连接句柄失效 | 连接按需懒开：`dbPromise` 为 `null` 时重开；SW 上下文销毁时句柄自然消失，无残留状态 |
| 扩展更新 / 别的上下文要升级 | 监听 `db.onversionchange` → 主动 `close()` 并清空单例，下次调用自动以新版本重开；`openDb` 监听 `onblocked` 打日志（配合上一条，正常情况不会真 blocked） |
| 事务被中止（存储压力 / 浏览器关闭） | 幂等写操作（`put` / `del`）**有限重试**：最多 2 次，退避 50ms / 150ms；只对 `AbortError` / `UnknownError` / `InvalidStateError` 重试，`ConstraintError` / `DataError` / `QuotaExceededError` **不重试**（重试不会好，只会掩盖问题） |
| 读发生在迁移完成前 | **初始化门闸**：所有读写先 `await ready()`，而 `ready()` 内部保证「开库 → 跑一次性迁移 → 校验」，因此不存在读到半迁移状态的窗口（正面解掉 §3.1 第 3 条） |
| 数据被浏览器回收 | 首次初始化时调用 `navigator.storage?.persist?.()` 请求持久化（存在性判断后再调，失败只记日志，不影响功能）。**不申请 `unlimitedStorage`**：IDB 配额本就远大于 10MB，而那个权限会加宽安装提示，收益与 `persist()` 重叠 |
| 静默失败 | 新层**不吞异常**：原语把错误抛给调用方；`useStoredValue` 的节流写入失败时，除了 `console.error` 还要在界面上给可见提示（现在是纯 console，`storage.ts:354-356`） |

两条工程约定：

- **schema 只追加不修改**：`upgrade()` 按 `oldVersion` 写成分块 `if (oldVersion < 1) { ... }`，以后加版本只追加新块，永不改动旧块（改了会让老用户与新用户走出不同形状）。
- **`durability` 是可选增强**：迁移那次写可尝试 `{ durability: 'strict' }`，用 `try/catch` 包住（不是所有实现都认这个选项），失败就按默认语义走。
- **可预见的校验一律在开事务之前做完。** 这是写单测时得到的一条硬规矩：「事务中途手动 throw → 靠 `abort()` 回滚」**不是可靠保证** —— 事务何时提交属于实现时序（fake-indexeddb 在微任务排空时提交，真实浏览器按任务边界提交），abort 可能来不及。真正可靠的是**请求失败引发的中止**（规范保证，已由单测钉住）。所以 `planMigration` 这类可能失败的计算全部放在事务之外，事务里只放写。

---

## 6. 关键替换：`storage.onChanged` → 经后台转发的显式广播

这是整个改造里唯一的**语义替换**。现状靠 `storage.onChanged` 让「设置页改了配置 → 侧边栏立即反映」；IndexedDB 没有任何变更事件。

**方案：复用仓库里已经跑通的 runtime 广播机制**（`messaging.ts` 的 `broadcastToPages` / `onPageBroadcast`，现在用于 `job-changed`）新增一条 `store-changed`：

```
写入方（页面或后台）┬─ 本地派发 ──▶ 本上下文自己的订阅者（同步）
                    └─ broadcastToPages ──▶ 其余所有上下文（异步）
```

**为什么必须有「本地派发」这一路**：`runtime.sendMessage` **不投递给发送者帧**。
只靠广播的话，发起变更的那个上下文自己收不到 —— 清空数据由设置页发起，它就收不到
那 4 条 `cleared`，三个 ref（含 API Key）继续显示旧值，但界面文案写着"各页面会立即
恢复默认值"；用户随后改一个字就把已清掉的数据写回库里。两路不会重复触发：发送者收不到
自己那条广播，别的上下文又不在本地登记表里。

> 这条链路最初写成「页面 → `callBackground` → 后台 → 转发」，在真机上错了两次：
> 一是「后台自己写数据时无人应答」（发送者收不到，响应 undefined → 调用方抛错），
> 二是「处理器返回 `void` 被判成没有响应」。两点都已在 `events.ts` 的模块头记录。

```ts
// src/logic/store/events.ts
type Scope = 'ai' | 'resume' | 'prompts' | 'records'
type ChangeKind = 'update' | 'cleared'

// 写入方调用，fire-and-forget
function notifyStoreChange(scope: Scope, kind: ChangeKind): void
// 订阅方调用，返回取消订阅
function onStoreChange(scope: Scope, cb: (kind: ChangeKind) => void): () => void
```

设计要点：

- **为什么不用 `BroadcastChannel`**（虽然它在概念上更贴合）：仓库里已经有一套经过验证的运行时广播机制，而 `BroadcastChannel` 在 MV3 service worker 里的可用性在各浏览器上并不一致，为一个「锦上添花」的通道引入跨浏览器不确定性不值得。走后台转发虽然多一跳（亚毫秒级），但**送达是确定的**：页面发消息时 SW 必然被唤醒，SW 广播时它本来就在运行。选择与既有 `job-changed` 完全同构，也就没有第二套心智模型。
- **`kind: 'cleared'` 是刻意新增的**：现在的 `storage.onChanged` 忽略删除事件，导致「清空数据后界面仍显示旧值」。新设计让清空事件**送达**，订阅方收到后把 ref 重置为 `fallback()` 并更新 `synced` 快照 —— 于是 `Options.vue:478-480` 那句「刷新页面后生效」可以删掉。已按 §9 决策 D 定为「立即重置」。
- **回声已经不存在**：广播不投递给发送者，本地派发又只发给「本上下文自己的订阅者」，所以写入方不会收到自己那条。`useStoredValue` 仍保留 `synced` 序列化快照比对 —— 它现在防的是另一件事：**旧快照回灌、覆盖用户刚敲的内容**（`storage.ts` 里那段注释记载的 Firefox 自激写循环坑依然要防）。
- **降级**：`notifyStoreChange` 用 `catch` 吞掉失败（后台没响应、没有页面在听都不该影响功能）；订阅方收不到广播时的行为等同于「本地写入已生效」，不会写崩。

---

## 7. 数据迁移（chrome.storage.local → IndexedDB）

### 7.0 三拍走：干跑 → 核对 → 真迁

| 拍 | 做什么 | 谁做 | 完成后 |
| --- | --- | --- | --- |
| **A 干跑** | 临时在侧边栏加一个「迁移预览」tab，**只读不写**，把归一化结果渲染成一份**脱敏报告** | 你运行并复制报告 | 报告发我核对（§7.1） |
| **B 核对** | 我逐项确认字段、条数、历史包袱都识别对了，必要时用报告里的形态补 fixture 单测 | 我 | 确认无误后才进 C |
| **C 真迁** | 移除临时 tab，按 §7.2 的流程正式迁移 | 实现 | 校验通过后删旧键 |

**关键约定：B 通过之前，`ensureStoreReady()` 里不接任何迁移逻辑。** 首次运行仍走现在的 `ensureStorageDefaults()`（即不迁移），这样干跑可以在真机上慢慢验证，不会先斩后奏。

### 7.1 干跑检查页（临时 tab，只读）

**位置**：侧边栏新增一个临时 tab（现有 tab 是 岗位 / 诊断 / 设置，见 `Sidepanel.vue:36,350`），命名「迁移预览」。

**只读保证**（这是它的全部意义，必须做到）：

- 只调 `browser.storage.local.get` / `getBytesInUse` 与纯函数。
- **不写任何键、不建 IDB 库。** 检测库里是否已有 `offer-hunter` 只能用 `indexedDB.databases()`（只列不打开、不创建）；没有该 API 时显示「无法检测」，**绝不**退化成 `open()` —— `open()` 会创建库，破坏只读性质。
- 组件里不存在任何 `set` / `put` / `migrate` 调用路径（评审时直接搜 `set(` 验证）。

**必须先确认的一件事：它得跑在持有数据的那个扩展实例里。**

`chrome.storage.local` 与扩展的 IndexedDB 都按 **extension ID** 隔离，而 unpacked 安装的 ID 由路径派生、商店安装的 ID 由商店固定。如果你装的是商店版、干跑却是本地构建，两者 ID 不同 —— 报告会显示「四个键都不存在」，那是**假警报**。所以：

- 报告**第一行打印 `runtime.id`**，并打印四个键的存在性；若全都不存在，报告顶部直接给出「可能不是持有数据的那个实例」的提示。
- 以源码构建后加载 `extension/` 的方式安装时，ID 由路径派生、只要路径不变就稳定，能读到原数据（README 推荐的安装方式正是这种）。

**干跑与正式迁移必须共用同一份转换逻辑**（否则干跑什么都证明不了）：

```ts
// src/logic/store/legacy.ts
interface MigrationPlan {
  settings: Array<{ id: SettingId, value: unknown, notes: string[] }>
  records: JobRecord[] // 已归一：键与字段都迁好
  dropped: { nonObjectRecords: number, prunedFields: string[] }
  counts: { records: number }
  checksums: Record<string, string> // 供迁移后核对「无损」
  legacyKeys: Array<{ key: string, present: boolean, kind: string, bytes: number }>
}

// 纯函数：给快照产出计划，可单测
function planMigration(raw: LegacySnapshot): MigrationPlan
// 只读：读旧键 → planMigration → 渲染脱敏报告
function previewMigration(): Promise<MigrationReport>
// 执行：读旧键 → planMigration → 单事务落库 → 校验 → 删旧键
function runMigration(): Promise<MigrationResult>
```

`planMigration` 是纯函数：干跑**渲染**它，正式迁移**执行**它。**两条路径不允许各写一份归一逻辑。**

**脱敏规则（默认如此，因为报告会被贴到聊天里）**：

| 数据 | 报告里呈现为 | 绝不呈现 |
| --- | --- | --- |
| 简历 markdown | 长度、行数、`sha256` 前 16 位 | **原文一个字都不出现** |
| API Key / Gist token | 是否存在、长度、`sha256` 前 16 位 | 值本身；连前缀默认也不显示 |
| `platform` / `baseUrl` / `model` / `maxTokens` | 原样（属于配置，不是密钥） | — |
| 账本记录 | 条数、键格式合规性、`siteId` 分布、时间范围、体积、**首条的字段名清单** | 职位名 / 公司名 / 招聘者 / 薪资的**值**；`error` 正文（只给条数） |

哈希的作用是决定性的：**迁移后同一字段的哈希必须逐项一致**，这就是「无损」的机器可验证证据 —— 而我们两边都不需要看到原文。

**报告里我需要看到的内容**（逐条对应 §3 的历史包袱）：

1. 四个键各自：存在性、原始类型（`object` 还是被 stringify 的 JSON 字符串）、`getBytesInUse` 体积、合计。
2. `resume`：`migrateResumeShape` 是否触发（有无 `gist` / `syncedFrom`）、`ensureSourceConfigs` 是否补了配置、**`mergeDefaults` 丢弃了哪些字段名** —— 数据丢失最容易藏在这一项。
3. `ai`：`platform` 的值、`apiKey` 是否非空（只看有无与长度）。
4. `records`：总条数、非对象条目数（会被丢弃）、键不含 `:` 的条数、含 legacy `securityId` / `status` 的条数、`siteId` 分布、`firstSeen` 范围、有 `match` / `greeting` / `error` 的条数、总体积与单条极值、首条记录的字段名清单。
5. 迁移预演：将写入哪些文档、多少条记录、预期的 `counts`。
6. 校验哈希表（迁移后逐项比对）。
7. `runtime.id` 与 `indexedDB.databases()` 的结果（确认实例正确、是否已有半迁移状态）。

**界面**：等宽文本渲染 + 一个「复制报告」按钮（复用现有的剪贴板写法），方便你直接粘贴。**脱敏在生成报告的那一层完成**，不依赖你复制时手动删。

**报告样例（这就是你会看到并贴给我的形状）**：

```text
=== Offer Hunter 迁移干跑报告 ===
时间 2026-09-29T10:12:03+08:00   版本 1.0.4   运行位置 sidepanel
扩展 ID abcdefghijklmnopabcdefghijklmnop
IDB 已有库 ["offer-hunter"]  ← 已有则说明可能存在半迁移状态，需先确认

[旧键概览]
offer-hunter-ai        存在  object        212 B
offer-hunter-resume    存在  字符串(JSON) 3.1 KB   ← reviveLegacyString 会复活它
offer-hunter-matching  不存在
offer-hunter-records   存在  object      812 KB
合计 getBytesInUse 815.3 KB

[ai]
platform "deepseek"   baseUrl (空)   model (空)   maxTokens 2048
apiKey 非空 长度 35 sha256 9f2c41a7d0b3e5c8
归一化 无字段增删

[resume]
markdown 长度 2841 行数 96 sha256 4b7ef0c2a9d8e1f3
sourceId "gist"    sources 补齐 [gist]
migrateResumeShape 未触发（无 gist / syncedFrom）
mergeDefaults 丢弃字段 无
gist.token 非空 长度 40 sha256 7a1c…
gist.gistId 存在 长度 32      gist.fileName "resume.md"
syncedKey 存在

[records]
条数 137   非对象条目 0   键不含':' 137（全部按 boss 迁移）
含 legacy securityId 137   含 legacy status 0
siteId 分布 { boss: 137 }
firstSeen 2026-01-11 … 2026-03-02
有 match 92   有 greeting 71   有 error 3
JSON 体积 812 KB   单条最大 3.1 KB   单条最小 0.4 KB
首条字段名 [siteId, naturalKey, title, company, recruiterName, salary, match, greeting, error, firstSeen]

[迁移预演·不写入]
将写入 settings：ai, resume, prompts
将写入 records：137 条
meta.migration.counts { records: 137 }
事务 1 个 readwrite（settings + records + meta）   迁移后删除旧键 是

[校验哈希·迁移后必须逐项一致]
resume.markdown            4b7ef0c2a9d8e1f3
resume.sources.gist.token  7a1c9b2d4e6f8a01
ai.apiKey                  9f2c41a7d0b3e5c8
records.digest             c31d7e5f0a9b2c48
```

#### 怎么跑（已实现，阶段 3a）

```bash
# 方式一：正式包 + 临时开这个 tab（不需要常驻开发服务器，推荐）
#   bash:       MIGRATION_PREVIEW=1 pnpm build
#   PowerShell: $env:MIGRATION_PREVIEW='1'; pnpm build
# 方式二：开发构建（此开关恒为开）
pnpm dev
```

然后到扩展管理页**重新加载**扩展 → 打开侧边栏 → 「迁移预览」→ 点「复制报告」。

⚠ 必须加载**同一路径**的 `extension/` 目录：unpacked 安装的扩展 ID 由路径派生，换个目录加载
就会看到「四个旧键都不存在」——那是另一个实例的存储，不是数据丢了。

#### 构建门控已实测

| 构建 | 实测结果 |
| --- | --- |
| `pnpm build`（默认） | 产物里**搜不到**「迁移预览」「干跑」任何一个字符串，也没有多余分包 —— 动态 import 被常量折叠一并去掉 |
| `MIGRATION_PREVIEW=1 pnpm build` | 多出一个独立的懒加载分包 `MigrationPreview-*.js`（约 10 KB），侧边栏切到该 tab 时才拉取 |

即便忘了删，默认构建也不会把它带给用户；阶段 3c 仍会按验收项要求把它删干净。

#### 干跑在实现阶段就查出了一个真 bug

写单测时发现：**「简历的值被 JSON 字符串化过」+「简历还是 legacy 的 `gist` 形状」这个组合，
legacy 配置永远不会被迁移。**

原因在 `migrateResumeShape`（`storage.ts:182-184`）：它开头就 `typeof raw !== 'object'` 直接返回，
而启动路径传进去的正是**未复活的原始值**（字符串）。也就是说这类存量用户的 Gist 配置一直是丢的
—— 而这两个特征属于同一个年代，是真实存在的组合。

修法：`normalizeResumeDoc` 里**先 `reviveLegacyString` 再迁移**。只影响「存的是字符串」这一种数据，
对正常对象的行为完全不变。

顺带修掉一处短路：旧写法 `migrateRecordKeys(all) || stripRemovedRecordFields(all)` 在「键要改名」
的那一次会**跳过字段清理**，要等下一次启动才补上。新的 `normalizeRecordLedger` 两件事一次做完，
终态与旧行为一致（因此不是破坏性改动）。

这两处都是「先干跑再迁」这条路线最直接的产出。

#### 第一次真机干跑的结果（2026-09-29）

| 项目 | 结果 | 含义 |
| --- | --- | --- |
| 扩展 ID | `heaeigkijbbofihoocalhakienjdmlhc` | 实例正确（四个键都读到了） |
| IndexedDB 已有库 | `[]` | 没有半迁移状态，可以干净地建库 |
| 存储用量 / 配额 | 52.7 KB / ≈10 GB | 配额完全不是问题 |
| 四个键 | 全部 `object` | **没有** JSON 字符串化的存量数据 |
| ai / resume / prompts | 归一化「无需改动」 | 没有 legacy 字段要裁、没有缺失要补 |
| resume | `sourceId=gist`、`sources.gist` 齐（gistId/fileName/token 都有） | 来源配置完好 |
| records | 86 条；非对象 0；键不含 `:` 0；legacy `securityId` 0；`status` 0 | **键改名与删字段这两类历史包袱在这台机器上都不存在** |
| records 分布 | `{boss: 75, eleduck: 11}`；有 match 83、greeting 52、error 3 | 与站点数量吻合，账本健康 |
| 体积 | 账本 166 KB（单条最大 7.3 KB） | 体积被 `jdText` 撑起来的（见下） |

**但发现了原方案没有预判到的一件事：整本账本仍是「重构前的记录形状」。**

首条记录的字段名是：

```
address areaDistrict bossName bossOnline bossTitle brandIndustry brandName
brandScaleName brandStageName businessDistrict cityName encryptBossId
encryptJobId error firstSeen greeting haveChatted isFriend jdText jobDegree
jobExperience jobName lastAction lastTouchedDate match naturalKey salaryDesc
siteId skills
```

也就是说这些记录是**接口原名 + 站点私有 id + 应用状态字段**的混合体，而今天的 `JobRecord`
只认 `title / company / recruiterName / salary / match / greeting / error / firstSeen / siteId / naturalKey`。
`types.ts:197,206` 恰好记录了这次重构（「jobName→title、brandName→company、bossName→recruiter」；
「原先这里是 18 个必填字段且交织着 BOSS 私有字段」），所以这些是重构之前写下的记录。

两个补充事实：

- `haveChatted` / `isFriend` / `lastAction` / `lastTouchedDate` 在整个 `src/` 里**一个消费方都没有**（grep 零命中）。
- `mergeDefaults` 对账本不裁剪（动态键映射的豁免），所以这些字段一直被原样保留 ——
  既没被清理，也没人读。

**这意味着迁移必须为「记录形状」做一个明确决定**（见 §9 决策 F）。

#### 干跑还暴露了报告本身的两个缺陷（已修）

1. **漏了 `[prompts]` 段** —— 三个设置文档只渲染了 ai 与 resume。这是实现疏漏，
   现已补上（含空值也照样出现，免得看报告的人分不清「空」与「没检查」）。
2. **只列首条记录的字段名** —— 于是"整本账本都是旧形状"这件事差点被漏掉：
   首条恰好是旧形状，但如果它恰好是新形状，我就会以为一切正常。

   现在改为：**整本账本的字段直方图**（字段名 → 含该字段的记录数，按计数降序，每行 4 个）
   + **形状分类**（含 `title` 几条 / 含接口原名几条 / 新旧都有几条 / 含 `jdText` 几条 /
   含站点私有 id 几条）+ **未知字段清单**。仍然只给字段名与计数，不给任何值。

> 教训值得写下来：**只抽查一条记录会给出错误的整体印象。** 干跑报告要么给全量统计，
> 要么明确标注「这是抽样」—— 不能让人误以为是全貌。

#### 第二次真机干跑（报告补齐后）：形状是干净的两分

| 形状 | 条数 |
| --- | --- |
| 含新字段名 `title` | **27** |
| 含旧接口字段名（jobName / brandName / bossName / salaryDesc） | **59** |
| 新旧都有（混合） | **0** |
| 含 `jdText` | 6 |
| 含站点私有 id（encryptJobId / encryptBossId） | 6 |
| 含未知字段（已加统计，下次报告给出精确值；按直方图 ≥59） | ≈59 |

27 + 59 = 86，**零混合** —— 说明这是两批不同版本写下的记录，而不是同一条记录被改过一半。
字段直方图还确认：那 27 条只带当前模型的 10 个字段；59 条旧记录里 12 条带 `lastAction` /
`lastTouchedDate`（自动化时代的遗留，`stripRemovedRecordFields` 当年只清了 `status`，
所以这两个兄弟字段留了下来）。

于是决策 F 定为 **F2**：迁移时按当前模型重建记录（见 §9 F）。

#### 实施 F2 时的两个设计决定

1. **归一化按白名单重建，而不是逐个删旧字段。**
   真机上未知字段有 23 个名字，逐个删的清单一定会漏。
   白名单来自 `types.ts` 新增的 `JOB_RECORD_FIELDS`，类型写成 `Record<keyof JobRecord, true>` ——
   **给模型增删字段而忘了同步它，编译就过不去**（写成 `string[]` 就会变成静默清字段）。
   同时归一化的字段字面量必须满足 `JobRecord`，两层编译期守卫。
   顺带接替了原先 `stripRemovedRecordFields` 的职责（`status` 不在白名单里，自然被丢掉），两套机制合成一套。
2. **`match` 只修已经坏掉的形状**（缺 `reasons` / `missingSkills` 数组时补成空数组），
   完好的原样返回（连引用都不换）—— 面板会 `match.reasons.join()`，缺了直接抛。
   报告里新增 `match 形状损坏` 一行，避免"悄悄改了数据"。

**临时性处理**（已落地）：

- 组件与 `Sidepanel.vue` 的 tab 项都标了 `TODO(临时)：迁移完成后删除`，并在 §10 阶段 3c 里列为必做验收项。
- 门控用编译期常量 `__MIGRATION_PREVIEW__`（`vite.config.mts` 里 `isDev || process.env.MIGRATION_PREVIEW === '1'`），
  并用 `defineAsyncComponent` + 动态 import —— 关掉时整段代码与分包一并消失（实测见下）。

### 7.2 正式迁移流程

挂在 `ensureStorageDefaults()`（现由 SW 顶层与 `onInstalled` 调用，`background/main.ts:53-63`）里，改名为 `ensureStoreReady()`，调用点不变：

```
ensureStoreReady()
 1. await openDb()                        // 建库/升级
 2. await navigator.storage.persist()     // 尽力而为
 3. 读 meta.migration
      └ 已 done 且 IDB 有数据 → 走 §7.4 的合并分支（仅当旧键又有内容）
 4. 读 chrome.storage.local 的四个键（一次 get）
      └ 四个都为空 → 写 meta.migration = done(fresh) 并返回（全新安装）
 5. planMigration(快照) → 一个 readwrite 事务覆盖 settings + records + meta：
      · settings: ai / resume / prompts 三个文档（用 plan 里已归一的值）
      · records : 逐条写入 plan.records
      · meta    : migration = { state: 'done', at, counts, checksums }
      └ 事务提交 = 全部落地；任何异常 = 整体回滚，旧键原封不动
 6. 事务提交后校验：count(records) 等于 plan.counts.records，且重算的 checksums
    与 plan.checksums 逐项一致（这一步就是「无损」的证据，不靠人眼比对）
 7. 校验通过 → 才删除 chrome.storage.local 的四个键；不通过 → 保留旧键并记错误，下次启动重试
```

**要点**

- **原子**：迁移标记写在同一个事务里，不存在「数据搬了一半、标记却写了」的中间态。
- **幂等**：标记存在就跳过；重复执行不会产生重复记录（`put` 本来就按键覆盖）。
- **可重试**：任何一步失败都不破坏源数据，下次启动重来。
- **可核对**：`meta.migration.counts` 与 `checksums` 一起落库；干跑报告里的哈希可以直接拿来对照，必要时也能支撑排障。
- **删旧键的时机**：只在**校验通过之后**。旧键是唯一的回退依据，这一步最需要保守。
- **为什么删而不是留**：留着等于简历 + API Key + Gist token 在明文里存两份，而隐私政策刚写明数据在扩展本地存储里 —— 留影子副本会让这句话不成立。

### 7.3 数据源可能长什么样（都要兼容）

迁移入口必须复用既有归一管线，否则会把这些历史包袱带进新库：

- 早期版本用模板的 `useWebExtensionStorage`，值被 `JSON.stringify` 成**字符串**存过（`:49-69`）；
- `resume.gist` / `resume.syncedFrom` 那个版本（`:182-215`）；
- 账本键只有 `securityId`、字段还叫 `securityId` 的版本（`:434-468`）；
- 记录里还留着 `status` 字段的版本（`:408-418`）。

> 迁移完成后，`readRecords()` 里「读的时候顺便 `migrateRecordKeys`」那段兜底（`:241-246`）可以删掉 —— 有了初始化门闸，读到未归一数据的窗口已经不存在。这是净减法。

### 7.4 回退场景（旧版本被装回来过）

用户装了 1.0.4 → 升到 1.1.0（迁移完成、旧键删除）→ 又手动装回 1.0.4。旧版本读 `chrome.storage.local` 是空的，会当成全新安装重新攒数据；再升回 1.1.0 时 `meta.migration` 已是 `done`。

处理规则（明确、可预期）：

| 数据 | 规则 |
| --- | --- |
| records | **按 key 取并集**，冲突时以 IDB 为准 |
| settings（ai / resume / prompts） | IDB 里若已有非默认内容 → IDB 为准；IDB 为空而旧键有内容 → 取旧键 |
| meta | 记一条 `conflictMergedAt` + 计数，便于排查 |

不写这段就会**静默丢掉旧版本期间产生的数据**，所以明确纳入范围。

---

## 8. 调用方需要改的地方（已按审计逐条核对）

| 位置 | 改动 |
| --- | --- |
| `background/main.ts:5-12` | 导入名 `ensureStorageDefaults` → `ensureStoreReady`（调用点 `:53`、`:57-63` 不变）；`onGetRecords`（`:266`）/`onUpsertRecord`（`:270`）内部换实现，**消息名与载荷不变**；新增 `store-changed` 处理器：**先失效后台自己的 memo，再 `broadcastToPages` 转发**（两步不可分离，见 §13.4） |
| `background/main.ts:285-294` | 注册表仍是同步顶层注册（MV3 要求），只多一项 |
| `Options.vue:15,51-59` | `useStoredValue` 的第一个参数从 `STORAGE_KEYS.ai` 改为 `'ai'`（同理 resume / prompts）；`resetAllStorage`（`:207`）调用不变；`:478-480` 的「刷新页面后生效」提示可删（§6 的 `cleared` 广播）；写入失败要给可见提示 |
| `QuickSettings.vue:5,19-20` | 同上，两处参数改为字面量 |
| `sidepanel/state.ts:228-240` | `syncRecords()`（读全表）按 §9 决策 B 改为「读当前岗位那一条」+ 订阅 `store-changed` |
| `sidepanel/Sidepanel.vue:149,183-207` | `persist()` 的消息调用不变；`records` 内存表按决策 B 收缩为「当前记录」；**临时加「迁移预览」tab**（阶段 3a 加、3c 必须删） |
| `logic/index.ts:1` | `export * from './storage'` 保持可用（无实际导入者，但属于公开面） |
| 测试 | `logic/__tests__/storage.spec.ts` 的纯函数测试迁到 `logic/store/__tests__/migrations.spec.ts`；新增 IDB / 迁移 / 事件测试 |

**不改**：`src/sites/**`（内容脚本永不碰 IDB —— 内容脚本里的 `indexedDB` 是**宿主页面**的存储，不是扩展的）、`src/platform/ai/**`、`src/manifest.ts` 的权限（见 §9 决策 C）。

**可以直接删掉的代码**：`serializeLedgerWrite` / `ledgerWriteChain`（`:251-264`）—— IDB 的 readwrite 事务对同一仓库是串行化的，「读一条、写一条、必要时淘汰」全部放进一个事务后，跨上下文并发也不再丢写。这是本次改造最实在的一处简化。

---

## 9. 决策记录（已拍板）

### A. 账本上限与配额策略 → **保持 2000 条，改用索引游标淘汰**

`MAX_RECORDS = 2000` 不变。淘汰从「全表排序」改为「`by-firstSeen` 升序游标 + `count()` 算溢出量后删除前 N 条」，全部在同一个 readwrite 事务里完成。用户可见行为与现在完全一致；将来若要提高上限或做按站点/时间的保留策略，属于独立的产品决策，不在本次范围。

### B. 侧边栏读取方式 → **只读当前岗位那一条 + 订阅变更**

`sidepanel/state.ts` 的 `syncRecords()`（现在读全表进 `reactive`）改为「按当前岗位的 `recordKey` 读一条」，并在当前岗位切换时重读；同时订阅 `store-changed` 的 `records` scope，写入方（本页面或后台）改动后立即刷新。这是本次改造的主要性能收益，也顺带修掉「清空数据后已打开的面板仍显示旧记录」。

`Sidepanel.vue` 的 `record` 计算属性与 `matchOf()` 从「查内存大表」改为「读当前记录 ref」，语义不变。

### C. 权限 → **保留 `storage` 一到两个版本，不新增 `unlimitedStorage`**

- 本次保留 `storage`：迁移必须读 `chrome.storage.local` 的四个旧键。跨版本升级的用户（哪怕跳过若干个小版本）只要 `storage` 还在，数据就能迁过来。
- **不加 `unlimitedStorage`**：IndexedDB 本身不需要任何权限，配额已是磁盘级别；防回收改用 `navigator.storage.persist()`（尽力而为，失败只记日志）。少一个权限就是少一行安装提示。
- **后续动作（单独排期）**：等迁移在真实用户中验证过一到两个版本，再单独发一版移除 `storage`，同时把隐私政策 §5.1 与 `docs/chrome-web-store.md` 的权限说明一起收窄。这一条记在这里，避免以后忘记或提前删掉导致跨版本升级丢数据。

### D. 清空数据 → **立即反映到界面，删掉「刷新页面后生效」提示**

新增的 `cleared` 广播让所有已打开页面立刻把相关 ref 重置为 `fallback()` 并更新 `synced` 快照。`Options.vue:478-480` 的「已清空，刷新页面后生效」文案随之删除。

这是一处**用户可见的行为变化**（比现在好）：现在因为 `storage.onChanged` 忽略删除事件（`storage.ts:376`），清空后已打开的侧边栏与设置页仍显示旧值，必须手动刷新。

### E. 内存缓存 → **做，写穿式每上下文 memo**

- `settings`（`ai` / `resume` / `prompts`）不限量，账本条目 LRU 32 条。
- 三条规矩：IDB 是唯一真相；memo 永不落盘；写穿顺序固定为「写 IDB → 更新 memo → 广播」。
- **不用 `chrome.storage.session`**：它虽然跨上下文共享，但读起来仍是一次 IPC 往返，收益远小于「又多一份要同步的数据」。
- 它被采纳的理由**不是性能，而是决策 B 的正确性前提**：面板现在靠 `Sidepanel.vue:200` 的乐观更新做到「点完分析立刻出结果」，收缩成按条读之后必须有内存落点，否则切回刚分析过的岗位会闪烁。完整论证见 §13。

### F. 存量记录的「旧形状字段」→ **已定 F2：归一成今天的 `JobRecord`**

真机干跑发现整本账本是重构前的记录形状（§7.1），其中 59/86 条含接口原名、
6 条含 `jdText` 与站点私有 id、12 条含自动化时代的遗留字段。**已按 F2 实施**：

| 处理 | 字段 |
| --- | --- |
| 映射到当前字段名 | `jobName→title`、`brandName→company`、`bossName→recruiterName`、`salaryDesc→salary` |
| 原样保留（当前模型内） | `siteId`、`naturalKey`、`match`、`greeting`、`error`、`firstSeen` |
| 丢弃 | `jdText`、`encryptJobId`/`encryptBossId`、`haveChatted`、`isFriend`、`lastAction`、`lastTouchedDate`、`address`、`cityName`、`areaDistrict`、`businessDistrict`、`bossTitle`、`bossOnline`、`brandIndustry`、`brandScaleName`、`brandStageName`、`jobDegree`、`jobExperience`、`skills`、`status`、`securityId` |

代价与兜底：这是**不可逆**的（旧键在校验通过后即删除），因此同期加了
**「导出原始数据（备份）」按钮**（临时 tab 内）——未脱敏的 JSON 直接下载到本机，
不经过任何服务器、不需要 `downloads` 权限。有了它，F2 才敢做。

两点说明：

- `haveChatted` / `isFriend` 被丢弃后，将来若要做路线图里的「过滤掉已聊过的岗位」，
  数据要从**实时页面/接口**取，而不是从账本读 —— 这与当前设计一致（账本只是结果缓存）。
- 保留 `cityName` 之类字段曾经考虑过（统计面板可能想看城市），但当前模型里没有，
  保留就会让模型与存储再次分叉；将来需要就**新增模型字段**，由实时数据填充。

---

## 10. 实施阶段（每阶段可独立验证）

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| 0 | 加 `fake-indexeddb` 开发依赖；在 `vite.config.mts` 补 `test.setupFiles`（**当前没有 setup 文件**，jsdom 30 也没有 `indexedDB`，不补则所有 IDB 测试跑不起来）；确认 `BroadcastChannel` 是否可用（本方案不依赖它，只作记录）—— ✅ **已完成**（`fake-indexeddb@6.2.5` + `src/tests/setup.ts`） | `pnpm test` 绿 |
| 1 | `platform/idb/`：`database.ts` + `schema.ts` + 单测（开库建仓、重开、versionchange、重试、事务回滚、跨 await 的失败正反例）—— ✅ **已完成**（单测 16 例） | 新单测覆盖 §5.3 六条对策 |
| 2 | `logic/store/`：`migrations.ts`（纯归一化，已搬出 `storage.ts` 以断开循环依赖）+ settings / **cache（写穿 memo）** / records / events / ready + 单测 | 读写往返、游标淘汰、清空、广播送达、**memo 命中与失效**、SW 收到广播后失效自己的 memo |
| 3a | **干跑**：`logic/store/legacy.ts` 的 `planMigration`（纯函数）+ `previewMigration` + 侧边栏临时「迁移预览」tab（只读、脱敏、带复制按钮、`MIGRATION_PREVIEW` 门控）。**可以最先做** —— 它只调用现有的纯函数（`mergeDefaults` / `migrateResumeShape` / `ensureSourceConfigs` / `migrateRecordKeys` / `stripRemovedRecordFields`），不依赖阶段 0–2，所以能立刻在真机上拿到报告 —— ✅ **代码已完成**（单测 19 例、lint/typecheck 通过、构建门控两种构建都实测过），等真机跑出报告 | 报告在真机上跑通；`planMigration` 的单测用合成快照覆盖四类历史包袱 |
| 3b | **核对**（你运行 → 我看报告）→ 按报告的真实形态补 fixture 单测；确认后才继续 —— ✅ **已完成**：两轮报告逐项对上，发现并定案了「存量记录旧形状」（决策 F → F2），并把真机形状写成 fixture 钉进单测 | 报告逐项对上，哈希表齐全 |
| 3c | **真迁**：`runMigration`（单事务 + checksums 校验 + 校验通过才删旧键）；记录按 F2 归一；**移除临时 tab**（`Sidepanel.vue` 的 tab 列表与组件一并删） | 五场景单测全绿；临时 tab 在 `git diff` 里确认已消失 |
| 4 | `logic/storage.ts` 改为门面；调用方按 §8 切换；落地决策 B / D / E | `pnpm lint && pnpm typecheck && pnpm test` |
| 5 | 文档同步（见 §11） | 文档与代码一致 |
| 6 | 真机验收 | 见下 |

**真机验收清单（用 1.0.4 的真实数据升级）**

0. **（干跑）** 在真机上打开「迁移预览」tab → 复制报告 → 发我核对；报告确认无误前，迁移逻辑不接入启动路径。
1. 装 1.0.4，填好简历 + API Key + Gist 配置，分析 2–3 个岗位，攒出账本。
2. 覆盖安装 1.1.0 → 简历、Key、提示词、账本**全在**；`chrome.storage.local` 四个键已删除（DevTools 确认）；IDB 三个仓库数据齐；`meta.migration.checksums` 与干跑报告里的哈希**逐项一致**（无损的机器证据）。
3. 点「清空本地数据」→ IDB 三仓全空、默认值重建、**侧边栏立即反映**（决策 B/D 落地后）。
4. 同时开设置页 + 侧边栏，改 API 配置 → 另一侧立即变（验证广播）。
5. SW 被回收后（`chrome://serviceworker-internals`，或等空闲）再操作 → 功能正常（验证懒开库）。
6. 写账本失败（可临时注入错误）→ 界面有可见提示，不是只在 console 里。
7. **缓存陈旧检查（最关键的一条）**：在设置页改完简历 → 立刻切到侧边栏点「分析匹配度」→ 确认用的是**新简历**（后台 memo 已被失效）。再点「生成打招呼语」→ 确认仍用新简历。
8. **缓冲回归检查**：分析岗位 B → 切到岗位 A → 再切回 B → 分数与招呼语**立即显示、无空白闪烁**（memo 命中）。

---

## 11. 连带需要更新的文档（诚实性要求）

隐私政策刚写完，且其中明确写了「不使用 IndexedDB」，这次必须同步改：

| 文件 | 要改什么 |
| --- | --- |
| `docs/privacy-policy.md` §3.1 | 「共四个键」→「扩展自己的 IndexedDB 数据库 `offer-hunter`，含 `settings` / `records` / `meta` 三个仓库」；**删掉**「不使用 localStorage / IndexedDB / Cache API」里的 IndexedDB；保留「不随浏览器账号同步、网页读不到、不加密」 |
| `docs/privacy-policy.md` §3.2 | 上限 2000 不变，补两点：① 淘汰改为按 `firstSeen` 索引游标；② **如实说明历史**：早期版本曾在账本里保存过 JD 原文，1.1.0 起迁移时会清除（这正是决策 F2 让「账本不保存 JD 原文」在迁移后对所有记录成立的原因） |
| `docs/privacy-policy.md` §3.4 | 清空数据 = 清空 IDB 三仓 + 重建默认值 +（若存在）删除迁移遗留的旧键 |
| `docs/privacy-policy.md` §5.1 / §12 | 权限表补 `navigator.storage.persist()` 的说明（请求持久化存储，避免被浏览器回收）；`storage` 权限的用途改为「仅用于读取旧版本遗留数据以完成迁移」 |
| `docs/privacy-policy.md` 附录 A | 行号引用全部刷新（`storage.ts` 会大幅改动） |
| `docs/chrome-web-store.md` | `storage` 权限理由同步（说明它只用于迁移） |
| `README_CN.md` / `README.md` | 「本地岗位账本」补一句「存在扩展自己的 IndexedDB 里」；架构章节补 `platform/idb` 与 `logic/store` 两层 |
| 本文件 | 实施完成后把状态改为「已实施」，并记下实际与方案的差异 |

---

## 12. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 迁移删了旧键但用户想回退 | 校验通过才删；删除前把 `counts` 写进 `meta`；可选加「导出数据（JSON）」按钮作为用户自己的备份手段 |
| 读到半迁移状态 | 初始化门闸：所有读写先 `await ready()` |
| 事务跨 await 被自动提交（IDB 经典坑） | 模块级约定写进注释；`runTx` 只在同一批 IDB 请求上 await，禁止把网络/消息等待塞进事务 |
| 广播机制在某些环境不可用 | 不依赖 `BroadcastChannel`；走已验证的 runtime 广播，失败只记日志不影响功能 |
| schema 后续版本改坏老数据 | `upgrade()` 分块只追加；加一个「空库断言仓库与索引齐备」的测试钉住 schema |
| 侧边栏改读单条后漏刷新 | 变更广播 + 当前岗位切换时主动重读，两条路径都覆盖 |
| 清空语义变化让用户困惑（决策 D） | 界面即时反映 + 移除「需刷新」文案；`cleared` 广播带 scope，只有相关 ref 重置 |
| **缓存陈旧导致用旧简历分析（决策 E 最严重的失败模式）** | SW 的 `store-changed` 处理器里「失效自己的 memo」与「转发」写在同一个地方（§13.4）；真机验收第 7 条专门验它 |
| 缓存被"顺手优化"成整表进内存 | memo 对账本硬性 LRU 32 条；`createMemo` 的容量参数是必填项之一，代码评审时对照 §13.3 |
| 缓存跨过初始化门闸（迁移未完成就读到空值并缓存） | memo 只在 `ready()` 之后填充；`cleared` 与迁移完成时整份清空 |
| **干跑报告把简历 / API Key / token 泄进聊天** | 报告在生成层就脱敏（§7.1 表格）：只给长度 / 行数 / 哈希，账本只给字段名与计数；`error` 正文不出现。哈希用 SHA-256，只够核对无损、不可逆 |
| 干跑显示「四个键都不存在」的假警报 | 报告首行打印 `runtime.id` 并检测 IDB 已有库；四个键全空时给出「可能不是持有数据的那个实例」的提示（§7.1） |
| 临时 tab 忘了删、随发布流出去 | 标 `TODO(临时)` + `__DEV__` 门控（发布构建里根本不存在）+ 阶段 3c 的验收项要求 `git diff` 里确认已删 |

**可选的加分项（不在必做范围）**：设置页加「导出数据（JSON）」按钮 —— 用户自己的备份手段，比在库里留影子副本干净。要做的话一并规划进阶段 4。

---

## 13. 内存缓存层（写穿式：「DB + Redis」里的那个 Redis）

**结论：做。** 但它的成立理由不是「更快」，而是「决策 B 的正确性前提」（§13.7）；并且必须按写穿 + 有界 + 事件失效来做，否则就会退化成 §13.8 说的那种「两个真相源」。

### 13.1 先澄清现状：权威读路径上没有任何缓存

| 上下文 | 现状 |
| --- | --- |
| **后台 SW** | **零缓存。** 每次 AI 调用都重新 `readAiSettings()` / `readResume()` / `readPromptSettings()`（`background/main.ts:190-194`、`:212-216`）；每次 upsert 读整张账本 |
| 设置页 | `useStoredValue` 的 `resume` / `ai` / `prompts` 是**内存中的 Vue ref**，但只在设置页这个上下文里，且是「挂载时读一次 + 靠 `onChanged` 更新」 |
| 侧边栏 | 同样各有一份 `useStoredValue` ref；账本则整表放在 `sidepanel/state.ts:20` 的 `reactive` 里 |

所以「简历存在内存里某个常量中」这个印象只在**页面侧**成立，而且每个页面各存一份；真正把简历发给 AI 的那条路径（后台）是每次现读的。

### 13.2 扩展里不存在「共享内存」，所以“Redis”有两种落法

| 方案 | 跨上下文共享 | 单次读开销 | 代价 |
| --- | --- | --- | --- |
| **每上下文 memo**（普通 JS 对象） | 否，SW / 侧边栏 / 设置页各一份 | **接近零**（根本不发 IPC） | 各上下文各自失效，需靠广播对齐 |
| `chrome.storage.session` | **是**（内存中、不落盘、10MB、浏览器关闭即清、带动 `onChanged`） | 仍是一次 **IPC 往返到浏览器进程**（只是不写盘） | 多一个存储要同步；依赖 `storage` 权限 |
| IndexedDB | 是 | 一次 IPC 往返（热数据本身走浏览器内存缓存） | 本次改造的主体 |

**关键判断：唯一能消掉「一次 IPC 往返」的是每上下文 memo。** `storage.session` 相对 IDB 只省了落盘那一环 —— 而热数据的 IDB 读本来就被浏览器缓存在内存里 —— 收益远小于它带来的「又多一份要同步的数据」。所以：**选 memo，不用 `storage.session`**（保留为将来的选项，见 §13.9）。

### 13.3 设计：写穿 + 有界 + 事件失效

```ts
// src/logic/store/cache.ts
interface MemoOptions {
  /** 缺省不限量；账本条目必须显式给一个较小的值 */
  max?: number
}

interface Memo<T> {
  get: (key: string) => T | undefined
  set: (key: string, value: T) => void
  delete: (key: string) => void
  clear: () => void
}

function createMemo<T>(options?: MemoOptions): Memo<T>
```

三条规矩（写进模块头部注释，评审时逐条对照）：

1. **IDB 是唯一真相**，memo 只是「最近读过的东西」；它**永不落盘**，也永不作为写入目标。
2. **写穿顺序固定**：先写 IDB → 再更新（或删除）memo → 最后广播。反过来会出现「广播发出去了，自己却还没改完」。
3. **memo 随时可以整份丢弃**，丢了只会多读一次 IDB，不丢数据、不影响正确性。**这条不变量是它安全的原因**：它不需要任何一致性保证。

容量边界：

| 缓存对象 | 容量 | 理由 |
| --- | --- | --- |
| `ai` / `resume` / `prompts` | 不限量（只有 3 条，KB 级） | 后台每次 AI 调用都要读这三个，命中率最高 |
| 账本条目 | **LRU，默认 32 条** | 绝不能退化成「整表进内存」—— 那正是本次要删掉的形状 |

### 13.4 一个必须做对的细节：SW 的 `store-changed` 处理器兼任「失效自己」

这是整个缓存设计里最容易漏、后果最严重的一处：

```
设置页改完简历 → 写 IDB → callBackground('store-changed', 'resume')
                             ↓
                          SW 收到：
                            ① 失效自己的 resume memo   ← 少了这一步就会出事
                            ② broadcastToPages('store-changed', ...)
```

漏掉 ① 的后果很具体：**用户刚在设置页改完简历，切到侧边栏点「分析匹配度」，后台拿的是自己 memo 里的旧简历，于是按旧简历打分并生成招呼语** —— 这是本功能最不能接受的失败模式（用户以为按新简历发的）。

所以「失效自己」与「转发给别人」必须写在同一个处理器里，并在注释里说明为什么它们不可分离。

### 13.5 已知竞态，以及为什么它不影响用户可感知的行为

窗口 = 「页面把新值写进 IDB」到「SW 失效自己的 memo」之间，约一跳消息（毫秒级）。这段时间里若正好有一次 AI 调用，会用旧值。

诚实地说：在「页面直写 IDB」的架构下这个窗口无法彻底消除。但它**不改变用户可感知的行为**，因为：

- `useStoredValue` 的写入本身**去抖 400ms**（`WRITE_DEBOUNCE_MS`，`storage.ts:303`）。也就是说「权威值与用户输入不一致」本来就是 400ms 级别 —— 用户敲完最后一个字符后的 400ms 内点分析，即使完全没有缓存，读到的也是旧值。
- 缓存引入的额外窗口（~1ms）比这个既有窗口**小两个数量级**。

要彻底消除它，得先动去抖或改成「写入即同步落盘」，那是另一个更大、且与本次目标无关的改动（若将来真要做，见 §13.10）。

### 13.6 广播载荷的分工：小的推值，大的推键

| scope | 广播内容 | 接收方行为 |
| --- | --- | --- |
| `ai` / `resume` / `prompts` | **带上新值**（KB 级，便宜） | 直接更新自己的 memo 与 ref，**不必再读一次** |
| `records` | 只带 **key** | 只有正在显示这个 key 的上下文才去读那一条 |

这条分工让「设置页改一下、侧边栏立即变」变成零额外读取，同时避免把账本条目塞进消息里。

### 13.7 为什么 memo 是决策 B 的必要前提（而不是可选优化）

决策 B 让面板不再持有整张账本。但**现在面板的体验依赖一个内存表**：`Sidepanel.vue:200` 是「先写内存 `records[key] = next`、再通知后台落盘」的乐观更新 —— 所以用户点完「分析」，分数立刻出现在界面上。

如果收缩成「每次都要异步读 IDB」，那么**从 A 岗位切回刚分析过的 B 岗位时会出现一瞬间的空白/闪烁**。这是**功能回归**，不是性能问题。

于是 memo 的作用不是「省几次读盘」，而是**提供「刚写进去的东西立刻能命中」的能力**：写穿更新 memo 之后，随之而来的读取是同步命中的，乐观更新才立得住。

### 13.8 为什么我修正了上一版的判断

上一版我按「延迟收益」否决了它，理由是「毫秒级开销服务秒级请求，收益量不出来」。那个算术没错，但**决策依据选错了**：

- 我漏了它是决策 B 的**正确性前提**（乐观更新的落点）。
- 更关键的是我把两件事混为一谈了：
  - **两个真相源** = 两份数据都「应该是对的」，于是需要一致性保证、需要对账、需要两处清理 → 这才是要消灭的病；
  - **一个真相源 + 一份可随时丢弃的副本** = 副本错了只是多读一次，**不需要任何一致性保证** → 这是安全的。

§13.3 的三条规矩（尤其第 3 条不变量）把它牢牢锁在第二种形态上。所以它不会重蹈「清空数据清不干净」「读到旧值」那类覆辙 —— 前提是规矩被遵守，而不是被「顺手优化」掉。

### 13.9 关于 `chrome.storage.session`（保留为将来选项）

如果将来出现「**必须**跨上下文共享、且**不能**碰磁盘」的热数据（例如需要多个上下文同时读写的投递队列），`storage.session` 是正确原语，而不是 `storage.local`。本次不需要，记录在此以备后用。

### 13.10 可选强化：把写全部收进后台

若将来那条毫秒级竞态变得不可接受（例如出现「简历一改就必须立刻生效」的强一致需求），做法是**所有写都经后台**（`put-setting` 消息），让 SW 成为唯一写者与唯一失效者。代价是每次（去抖后的）写多一跳消息。本次不做，因为 §13.5 已说明现有去抖窗口远大于它。

### 13.11 顺带被这次改造消掉的一处真实开销（不靠缓存）

现状每次 **service worker 启动**都会执行 `ensureStorageDefaults()`（`background/main.ts:53`，顶层 fire-and-forget），而它会 `storage.local.get` 四个键 —— **包括 1–3MB 的整张账本** —— 再对全表做两次遍历（`migrateRecordKeys` + `stripRemovedRecordFields`，`:529-530`）。

关键在于 MV3 的 SW **空闲 30 秒就被回收**，活跃使用时会被反复唤醒，所以这不是「每次安装一次」，而是**反复发生**的整表读取与反序列化。

换成 IDB + `meta.migration` 标记之后，启动只剩「开库 + 读一条 meta」；归一化只在首次迁移时做一次，之后是空操作。这处收益来自**删掉那个大 blob 的形状**，与 §13 的内存缓存无关 —— 两者解决的是不同问题，别混在一起记账。

> 附带说明：`ai` / `resume` / `prompts` 三处确实有 `JSON.stringify` 比对（`:497,517,521`），但账本没有（`:530` 只做遍历）。所以现状的账本开销是「读盘 + 反序列化 + 两次遍历」，不是 stringify。
