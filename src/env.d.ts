/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  // 三个空对象是 DefineComponent 的类型参数（props / raw bindings / data），
  // 换成 Record<string, never> 会让 props 变成"不允许任何键"，反而更错
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  const component: DefineComponent<{}, {}, unknown>
  export default component
}
