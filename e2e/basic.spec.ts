import { expect, test } from './fixtures'

/**
 * 端到端冒烟测试。
 *
 * 只覆盖「扩展能装起来、两个界面能渲染」这条底线：
 *  - content script 不再有界面（面板已搬到侧边栏），因此没有页面内断言
 *  - 曾经这里还有一个 popup 用例，popup 已随侧边栏方案删除
 *
 * ⚠ 需要 Playwright 自带的 Chromium（系统的 Chrome 137+ 已不接受
 * --load-extension，扩展装不上）：npx playwright install chromium
 */

test('options page', async ({ page, extensionId }) => {
  await page.goto(`chrome-extension://${extensionId}/dist/options/index.html`)

  await expect(page.locator('img')).toHaveAttribute('alt', 'Offer Hunter')
  // 三个标签都在，说明 Vue 应用挂载成功
  await expect(page.getByRole('button', { name: '简历', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '打招呼', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'AI 平台', exact: true })).toBeVisible()
})

test('sidepanel page', async ({ page, extensionId }) => {
  await page.goto(`chrome-extension://${extensionId}/dist/sidepanel/index.html`)

  // 侧边栏在没有 BOSS 页面时应给出明确提示，而不是白屏
  // （exact 必需：工具条上还有「刷新当前岗位」，按子串匹配会命中两个）
  await expect(page.getByRole('button', { name: '岗位', exact: true })).toBeVisible()
  await expect(page.getByText('当前标签页不是 BOSS 直聘')).toBeVisible()
})
