declare const __DEV__: boolean
/** Extension name, defined in packageJson.name */
declare const __NAME__: string

declare module '*.vue' {
  const component: any
  export default component
}

/** Monaco 的全局环境配置，用于声明不需要 web worker */
interface Window {
  MonacoEnvironment?: import('monaco-editor-core').Environment
}
