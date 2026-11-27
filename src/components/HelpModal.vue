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
    title: '选中与多选',
    rows: [
      ['单击', '选中框（3D 视图同样支持）'],
      ['Ctrl 单击', '追加 / 取消一个对象'],
      ['空白拖拽', '橡皮筋框选一批对象'],
      ['拖动已选成员', '整组一起平移'],
      ['Tab / ⇧Tab', '切到下一个 / 上一个对象'],
      ['Ctrl A', '全选'],
      ['Ctrl B', '把选中框复制到后续所有帧（同 id，直接构成轨迹）'],
      ['Esc', '取消全部选中'],
      ['1 – 9', '把选中对象的类别改成第 N 个类别（无选中时只改默认类别）'],
    ],
  },
  {
    title: '编辑与视图',
    rows: [
      ['拖角点', '在 Top 视图缩放长宽'],
      ['拖黄点', '旋转朝向（按住 Shift 吸附 15°）'],
      ['方向键', '微调位置（Shift 大步长，PgUp/PgDn 调高度）'],
      ['中键 / 右键拖', '平移正交视图'],
      ['滚轮', '以光标为中心缩放'],
      ['双击视图', '最大化 / 还原'],
      ['悬停', '3D 视口、三张正交视图、相机投影图同步高亮，并在框旁显示长×宽×高与朝向'],
      ['三视图联动缩放', '右侧「外观」里勾选后，三个正交视图保持相同米/像素'],
      ['三视图联动平移', '右侧「外观」里勾选后，在一个视图里平移，另外两个跟着走相同的世界距离'],
    ],
  },
  {
    title: '通用',
    rows: [
      ['W A S D', '平移选中框（Shift 大步长）'],
      ['Q E', '旋转朝向'],
      ['R F', '调长度'],
      ['⇧ F', '用框内点云重新拟合（PCA 主方向 + 尺寸）'],
      ['Ctrl C / V', '复制 / 粘贴（支持多选）'],
      ['Ctrl D', '原地复制一份'],
      ['Delete', '删除所有选中（锁定的自动跳过）'],
      ['Ctrl Z / ⇧Z', '撤销 / 重做'],
      ['Ctrl S', '导出当前帧'],
      ['Ctrl ⇧ S', '导出整段序列'],
      [', / .', '上一帧 / 下一帧'],
      ['⇧ , / ⇧ .', '跳到上一处 / 下一处有标注的帧'],
      ['F1', '打开 / 关闭本面板'],
    ],
  },
]
</script>

<template>
  <!-- data-modal：全局快捷键据此判断"有弹窗打开"，见 useAnnotation 的 shouldIgnoreShortcut -->
  <div v-if="showHelp" class="modal-mask" data-modal="help" @click.self="showHelp = false">
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
          数据流：点云 → Top 拖框 → Side 调高度 → 属性面板精调 → 自动保存到浏览器 → 导出 SUSTechPOINTS 兼容
          JSON。序列场景可用 <kbd>Ctrl</kbd>+<kbd>B</kbd> 把标好的框铺到后续帧，
          再逐帧微调；参考线刻度靠每个视图左下角的比例尺读取，光标处的点云坐标显示在状态栏右侧。
        </div>
      </div>
    </div>
  </div>
</template>
