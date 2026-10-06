import type { SiteRef } from '~/logic/types'
import { sameApiView, sameJobFromUrl } from '../dom-fallback'
import { hostnameOf, isHostOf } from '../hostnames'
import { defineSite } from '../types'
import {
  buildDomFallbackJob,
  getTopicBody,
  getTopicContainer,
  readJdFromDom,
  readJobOutlineFromDom,
} from './dom'
import meta from './meta'
import {
  JOB_NODE_LINK,
  TOPIC_CONTENT,
  TOPIC_TITLE,
  topicIdFromUrl,
} from './selectors'

/**
 * V2EX 适配器。
 *
 * 与其他站点的关键差别是 `source: 'dom'`：V2EX 没有可用的岗位接口（正文由服务端
 * 直接渲染进 HTML），岗位完全从页面读 —— 所以这里不实现那四个接口方法，
 * manifest 也不会给这个站点注入 MAIN world 脚本。
 *
 * 另一处差别是**帖子即岗位，但要挑节点**：V2EX 是一个综合论坛，只有发在
 * 「酷工作」节点（`/go/jobs`）的帖子才算岗位。判据是节点头部里那条 `/go/jobs`
 * 链接（见 selectors.ts 的 isJobPostPage），别的节点下的帖子一律不认 ——
 * 因此内容脚本在非工作帖上不会产生任何岗位。
 *
 * 本文件是**唯一**允许出现 `v2ex` / `topic_content` 这类站点知识的边界之一
 * （另一个是 meta.ts / selectors.ts / dom.ts）。
 */
export default defineSite({
  meta,

  // 没有要捕获的接口（见文件头；空数组由 `'dom'` 强制）
  watchedApiPaths: [],

  // 与路由层（routing.ts）共用同一套主机名判定，不另写一个正则
  matchUrl: url => isHostOf(hostnameOf(url), meta.hostnames),

  // /t/1245478 → 1245478
  naturalKeyFromUrl: topicIdFromUrl,

  /*
   * 岗位页就是主题页 `/t/<id>`（地址里带着帖子 id）。节点页 `/go/jobs` 不算：
   * 那里只有列表，正文与标题都不在。
   *
   * ⚠ 与 DOM 层面的判据（selectors.ts 的 isJobPostPage：节点得是「酷工作」）分工
   *   不同：这里只回答「地址上有没有一个主题」，这个主题算不算工作帖由 readJd 决定。
   *   V2EX 里别的节点的主题页因此会「是岗位页但没有岗位」—— 这是对的：
   *   那种页面上不该显示上一个岗位。
   */
  isJobPage: url => topicIdFromUrl(url) !== '',

  readJd: readJdFromDom,

  /*
   * 观察器容器：正文所在的那个 `cell`。
   *
   * 这里与 readJd / readOutline 一样**不**做「是不是工作帖」的判定 —— 契约要求
   * 容器选择器只回答「容器在不在」，而 `.topic_content` 本来就只出现在主题页上，
   * 列表页拿不到它。判定留给 readJd / readOutline（见 sites/types.ts 的说明）。
   */
  jdProbeElement: getTopicBody,

  jdContainerElement: getTopicContainer,

  buildDomFallback: buildDomFallbackJob,

  readOutline: readJobOutlineFromDom,

  /**
   * 是否同一个岗位。
   *
   * 与电鸭逐字相同的判据走共用骨架（sites/dom-fallback.ts 的 sameJobFromUrl）：
   * 主题地址里就带着帖子 id，优先比它；拿不到时退回文本比对。
   */
  sameJob: (existing, jd) => sameJobFromUrl(topicIdFromUrl, existing, jd),

  sameApiView,

  emptyRef: (naturalKey): SiteRef => ({ siteId: meta.id, naturalKey }),

  diagnose() {
    const selectors = [
      { key: 'title', label: '帖子标题行', selector: TOPIC_TITLE },
      { key: 'nodeLink', label: '节点链接（工作帖判据）', selector: JOB_NODE_LINK },
      { key: 'body', label: '帖子正文', selector: TOPIC_CONTENT },
    ]

    return {
      selectors,
      domOutline: readJobOutlineFromDom(),
      jdLength: readJdFromDom()?.length ?? 0,
    }
  },
})
