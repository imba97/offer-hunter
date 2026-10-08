declare const __DEV__: boolean
/** Extension name, defined in packageJson.name */
declare const __NAME__: string

declare module '*.vue' {
  const component: any
  export default component
}

/**
 * Vite 把 `?worker` 后缀的文件打成单独的 web worker chunk，import 返回一个
 * Worker 构造函数，`new Worker()` 时才会真正创建线程。
 *
 * 参考 https://cn.vite.dev/guide/features.html#web-workers
 */
declare module '*?worker' {
  const workerConstructor: {
    new (): Worker
  }
  export default workerConstructor
}

/** Monaco 的全局环境配置，用于声明不需要 web worker */
interface Window {
  MonacoEnvironment?: import('monaco-editor-core').Environment
}
