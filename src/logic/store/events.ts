import type { SettingId } from './settings'
import { broadcastToPages, onPageBroadcast } from '~/logic/messaging'

/**
 * 「存储变了」的跨上下文广播 —— 替代 `storage.onChanged`。
 *
 * IndexedDB 没有任何变更事件，而「设置页改了配置 → 侧边栏立即反映」必须继续成立，
 * 所以改成显式广播。通道复用仓库里已经跑通的 runtime 消息（`job-changed` 那条），
 * **刻意不用 `BroadcastChannel`**：它在 MV3 service worker 里的可用性各浏览器不一致，
 * 为一个附加通道引入跨浏览器不确定性不值得。完整论证见 docs/indexeddb-migration.md §6。
 *
 * 链路：**写入方直接广播，不经后台转发**
 *   页面写入 ──broadcastToPages──▶ 其余所有页面
 *   后台写入 ──broadcastToPages──▶ 所有页面
 *
 * ⚠ 这里曾经写成「页面 → callBackground → 后台 → broadcastToPages」，是错的，
 *   而且错两次（真机各暴露一次，都记在下面）：
 *
 *   1. **后台自己写的时候根本没人应答。** `runtime.sendMessage` **不会投递给发送者
 *      自身**，所以后台调 `callBackground('store-changed')` 时，它自己那个处理器
 *      收不到，响应为 undefined，调用方抛「后台没有响应」。
 *      真机症状：每次写账本（账本正是后台写的）都在控制台留一条
 *      `通知 records 变更失败（写入已落库，不影响功能）`。
 *   2. 即便处理器被调用了，它当时返回 `void` —— 而消息层把「返回 undefined」当作
 *      「没有响应」，同样会让调用方抛错。
 *
 *   去掉转发这一跳同时解决两者，而且更简单：`sendMessage` 会把消息投给扩展内
 *   **除发送者帧以外**的所有上下文，页面之间本来就能直接互通，不需要后台当中继。
 *
 * 顺带一提：直接广播后**写入方收不到自己那条**（发送者被排除），所以没有回声。
 * 订阅方（`useStoredValue`）仍保留 `synced` 快照比对 —— 它还要防「旧快照回灌、
 * 覆盖用户刚敲的内容」，那是另一件事。
 */

export type StoreChangeKind = 'update' | 'cleared'

/**
 * 可以通知变更的域。
 *
 * 从 `SettingId` 派生而不是另抄一遍字面量：将来加第四个设置文档时，
 * 忘了同步这里会让它的变更广播不出去（症状是「改了不生效」，很难查）。
 */
export type StoreScope = SettingId | 'records'

export interface StoreChangeMessage {
  scope: StoreScope
  kind: StoreChangeKind
}

/**
 * 通道名。
 *
 * 后台**不**注册同名请求处理器：这个通道只走广播，不走请求/应答。
 * （将来决策 E 的内存 memo 落地时，后台要失效自己的 memo，就在后台用
 * `onStoreChange` 订阅这个广播 —— `browser.runtime.onMessage` 在 SW 里同样有效。）
 */
const CHANNEL = 'store-changed'

/**
 * 写入方调用（页面或后台）：fire-and-forget。
 *
 * **失败只记日志，绝不往上抛**：写入本身已经落库，通知是附加动作 —— 因为「没有别的
 * 页面在听」而让调用方看到错误、甚至把写入当成失败，等于把附加功能的故障升级成核心
 * 功能的故障。
 */
export function notifyStoreChange(scope: StoreScope, kind: StoreChangeKind = 'update'): void {
  try {
    broadcastToPages(CHANNEL, { scope, kind } satisfies StoreChangeMessage)
  }
  catch (error) {
    console.warn(`[offer-hunter] 通知 ${scope} 变更失败（写入已落库，不影响功能）`, error)
  }
}

/**
 * 订阅方调用（页面内）：返回取消订阅函数。
 *
 * 只认自己 scope 的消息；载荷不合法（缺 scope / 认不出的 kind）直接忽略 ——
 * 广播是原样透传的，别的上下文（可能是旧版本）发什么就传什么；
 * 收到认不出的形状按「没有变更」处理，绝不能对 undefined 继续取值。
 */
export function onStoreChange(scope: StoreScope, cb: (kind: StoreChangeKind) => void): () => void {
  return onPageBroadcast<StoreChangeMessage>(CHANNEL, (data) => {
    if (!isStoreChangeMessage(data) || data.scope !== scope)
      return
    cb(data.kind)
  })
}

function isStoreChangeMessage(value: unknown): value is StoreChangeMessage {
  if (value === null || typeof value !== 'object')
    return false
  const message = value as Partial<StoreChangeMessage>
  return typeof message.scope === 'string'
    && (message.kind === 'update' || message.kind === 'cleared')
}
