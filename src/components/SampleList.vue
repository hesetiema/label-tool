<script setup lang="ts">
/**
 * 本地样本列表。
 *
 * 【为什么要有】21.6 决定了不自动删文档（文档是标注真值，不是缓存），
 * 那就必须给用户一条手动出口。这个弹层就是出口：看有什么、什么时候存的、
 * 有哪些任务段，然后把确实不要的删掉。
 *
 * 【为什么删除是两次点击】文档删了框就没了。一次点击就删的低频高危动作，
 * 用二次确认比用「撤销」更可靠 —— 删除不进历史栈。
 */
import { inject, onBeforeUnmount } from 'vue'
import { StudioKey } from '../state/studioContext'

const studio = inject(StudioKey)!
const {
  open,
  rows,
  loading,
  error,
  usage,
  pendingId,
  busyId,
  summary,
  closeList,
  refresh,
  requestRemove,
  cancelRemove,
  confirmRemove,
  formatBytes,
} = studio

/** Esc 关闭：只在弹层打开时抢键，避免影响画布快捷键 */
function onKey(e: KeyboardEvent) {
  if (!open.value) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    closeList()
  }
}
window.addEventListener('keydown', onKey, true)
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <div v-if="open" class="modal-mask" @click.self="closeList">
    <div class="modal lib-modal">
      <header class="modal-head">
        <h3>
          本地样本<span class="lib-count">{{ summary().total }}</span>
        </h3>
        <div class="lib-head-right">
          <span v-if="usage && usage.quota" class="lib-usage" title="浏览器为本站分配的配额">
            {{ formatBytes(usage.used) }} / {{ formatBytes(usage.quota) }}
          </span>
          <span v-else-if="usage" class="lib-usage">{{ formatBytes(usage.used) }}</span>
          <button class="mini-icon" title="重新读取" @click="refresh">⟳</button>
          <button class="mini-icon" @click="closeList">✕</button>
        </div>
      </header>

      <div class="lib-body">
        <p v-if="error" class="lib-error">{{ error }}</p>
        <p v-if="loading && !rows.length" class="lib-empty">读取中…</p>
        <p v-else-if="!rows.length" class="lib-empty">本地还没有保存过样本。编辑并等待自动保存后，这里会出现一行。</p>

        <ul v-else class="lib-list">
          <li
            v-for="r in rows"
            :key="r.sampleId"
            class="lib-row"
            :class="{ current: r.isCurrent, busy: busyId === r.sampleId }"
          >
            <div class="lib-main">
              <div class="lib-title">
                <span class="lib-scene">{{ r.sceneId }}</span>
                <span v-if="r.isCurrent" class="lib-tag">当前</span>
                <span class="lib-age" :title="r.atText">{{ r.ageText }}</span>
              </div>
              <div class="lib-meta">
                <span class="lib-id">{{ r.sampleId }}</span>
                <span class="lib-sep">·</span>
                <span>{{ r.frameCount }} 帧</span>
                <template v-if="r.taskLabels.length">
                  <span class="lib-sep">·</span>
                  <span v-for="t in r.taskLabels" :key="t" class="lib-task">{{ t }}</span>
                </template>
              </div>
            </div>
            <div class="lib-actions">
              <template v-if="pendingId === r.sampleId">
                <button class="lib-btn danger" @click="confirmRemove(r.sampleId)">确认删除</button>
                <button class="lib-btn" @click="cancelRemove">取消</button>
              </template>
              <button
                v-else
                class="lib-btn"
                :disabled="r.isCurrent || busyId === r.sampleId"
                :title="r.isCurrent ? '当前正在编辑的样本不能在这里删' : '删除这份文档（标注会一起删掉）'"
                @click="requestRemove(r)"
              >
                {{ busyId === r.sampleId ? '删除中…' : '删除' }}
              </button>
            </div>
          </li>
        </ul>

        <p class="lib-note">
          删除只清文档（标注真值），不进撤销栈。帧缓存与没人引用的载荷会在随后的清扫里回收。
          当前这份如果确实不要了，用菜单里的「清除本地草稿」—— 那条路会连帧缓存一起清掉。
        </p>
      </div>
    </div>
  </div>
</template>
