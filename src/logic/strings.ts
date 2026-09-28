/**
 * 字符串取值。
 *
 * 存储里的值与后台消息都是 `unknown`（用户可能手改过存储、旧版本可能写过别的类型），
 * 直接 `.trim()` 会在渲染期抛 "Cannot read properties of undefined"。
 * 这个函数此前在来源适配器、来源面板与各站点适配器里各写了一遍。
 */
export function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
