import type { InjectionKey } from 'vue'
import type { useStudio } from './useStudio'

/** useStudio 返回的完整工作台实例，供各面板组件通过 inject 共享同一份状态 */
export type Studio = ReturnType<typeof useStudio>

/** 面板组件共享的 studio 实例注入键 */
export const StudioKey: InjectionKey<Studio> = Symbol('studio')
