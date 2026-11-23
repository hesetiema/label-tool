<script setup lang="ts">
/** 快捷键与工作流说明（F1 打开）。取代原来常驻右侧的帮助栏，把画布宽度让出来。 */
import { inject } from 'vue'
import { StudioKey } from '../state/studioContext'

const studio = inject(StudioKey)!
const { showHelp } = studio

const groups = [
  {
    title: '画一个 3D 框',
    rows: [
      ['N', '切到画框工具，并自动最大化 Top 视图'],
      ['拖拽', '在 Top 视图拖出矩形 → 生成带默认高度的 3D 框'],
      ['Side 拖绿点', '调整高度（底面固定）'],
      ['V', '回到选择工具'],
    ],
  },
  {
    title: '编辑与视图',
    rows: [
      ['单击', '选中框（3D 视图同样支持）'],
      ['拖角点', '在 Top 视图缩放长宽'],
      ['拖黄点', '旋转朝向（按住 Shift 吸附 15°）'],
      ['中键 / 右键拖', '平移正交视图'],
      ['滚轮', '以光标为中心缩放'],
      ['双击视图', '最大化 / 还原'],
    ],
  },
  {
    title: '通用',
    rows: [
      ['W A S D', '平移选中框（Shift 大步长）'],
      ['Q E', '旋转朝向'],
      ['R F', '调长度'],
      ['Ctrl C / V', '复制 / 粘贴框'],
      ['Ctrl D', '原地复制一份'],
      ['Delete', '删除'],
      ['Ctrl Z / ⇧Z', '撤销 / 重做'],
      ['Ctrl S', '导出当前帧'],
      ['Ctrl ⇧ S', '导出整段序列'],
      ['F1', '打开 / 关闭本面板'],
    ],
  },
]
</script>

<template>
  <div v-if="showHelp" class="modal-mask" @click.self="showHelp = false">
    <div class="modal">
      <header class="modal-head">
        <h3>快捷键与工作流</h3>
        <button class="mini-icon" @click="showHelp = false">✕</button>
      </header>
      <div class="modal-body">
        <div v-for="g in groups" :key="g.title" class="key-group">
          <h4>{{ g.title }}</h4>
          <div v-for="r in g.rows" :key="r[0]" class="key-line">
            <kbd>{{ r[0] }}</kbd>
            <span>{{ r[1] }}</span>
          </div>
        </div>
        <div class="modal-note">
          数据流：点云 → Top 拖框 → Side 调高度 → 属性面板精调 → 自动保存到浏览器 →
          导出 SUSTechPOINTS 兼容 JSON。序列场景可在「更多 → 时序与 4D」做插值、跟踪与质检。
        </div>
      </div>
    </div>
  </div>
</template>
