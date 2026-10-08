/**
 * Monaco 编辑器后台 worker。
 *
 * 加载 monaco-editor-core 自带的 EditorWorker 实现，
 * 给链接识别、词级补全、diff 等「需要计算但又不能阻塞输入」的事用。
 *
 * 为啥 Markdown 编辑器也要它：
 *
 * `EditorWorkerService` 给**所有**语言都注册了默认的链接 provider
 * 和词级补全 provider（注册用的是 `*`），并不是「有语言服务才要 worker」。
 * 不提供 worker 时，Monaco 会触发两条消息：
 *
 *   - 「Could not create web worker(s). Falling back to loading web worker
 *     code in main thread, which might cause UI freezes.」
 *   - 编辑器内部走的 fallback 路径 —— 即 Monaco 自己捕获 getWorker 抛错
 *     后回到 SynchronousWorkerClient 在主线程跑
 *
 * 警告本身只是噪音，但「Monaco 内部链接识别/词级补全在主线程跑」
 * 也是真负担（输入时同步计算）。干脆让它在 worker 里跑。
 *
 * 通过 Vite 的 `?worker` 导入，会被打成单独的 worker chunk，
 * 不会重复进主编辑器 bundle，也不需要写额外构建配置。
 */
import 'monaco-editor-core/esm/vs/editor/common/services/editorWebWorkerMain'
