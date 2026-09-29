/**
 * 单测全局准备。
 *
 * 唯一要做的事：**给 jsdom 装上 IndexedDB**。
 *
 * jsdom 不实现 IndexedDB（`globalThis.indexedDB` 是 undefined），而存储层
 * 第一阶段就搬到 IndexedDB 上了 —— 没有这一行，所有涉及存储的单测都跑不起来，
 * 且失败信息会是一句很难联想到原因的 "Cannot read properties of undefined"。
 *
 * 用 `fake-indexeddb/auto` 而不是在每个 spec 里手工 import：它是纯内存实现，
 * 装上之后行为与浏览器一致（事务、游标、索引、结构化克隆都支持），
 * 而且**没有全局状态需要清理** —— 每个 spec 自己删掉用到的库即可
 * （见 `src/logic/store/__tests__/` 里的 resetDatabase）。
 */
import 'fake-indexeddb/auto'
