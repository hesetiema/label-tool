<template>
  <aside class="help">
    <h3>快捷键</h3>
    <div class="keyrow"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>平移选中框</span></div>
    <div class="keyrow"><kbd>Q</kbd><kbd>E</kbd><span>旋转朝向</span></div>
    <div class="keyrow"><kbd>R</kbd><kbd>F</kbd><span>调整长度</span></div>
    <div class="keyrow"><kbd>Shift</kbd><span>大步长</span></div>
    <div class="keyrow"><kbd>Del</kbd><span>删除</span></div>
    <div class="keyrow"><kbd>Ctrl</kbd>+<kbd>Z</kbd><span>撤销</span></div>
    <div class="keyrow"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd><span>重做</span></div>
    <div class="keyrow"><kbd>Ctrl</kbd>+<kbd>S</kbd><span>导出</span></div>
    <div class="tip">
      <b>工作原理</b>
      <p>在 BEV 拖拽框选点云 → PCA 估计主方向 → 自动拟合出贴合的 3D 框。这就是原仓库"半自动标注"的核心思路。</p>
    </div>
  </aside>
</template>
