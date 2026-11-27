# 变更记录

格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号参照 [SemVer](https://semver.org/lang/zh-CN/)。

因为这是学习项目，`0.x` 阶段不承诺向后兼容；但**导出文件格式**（标签 JSON、`.occ`、
VLA JSONL）一旦发布就尽量保持可读，破坏性变更会在下面明确写「不兼容」。

## [Unreleased]

分两批：**第一批补工程基建 + 修评审发现的真 bug**，**第二批补数据进出与渲染兜底**
（P1 的高价值项）。完整评审与路线图见 [`docs/12-review.md`](docs/12-review.md)。

### Added

- **ESLint 10（flat config）+ Prettier 3**：`pnpm lint`（`--max-warnings 0`）与 `pnpm format`
- **Vitest + `@vitest/coverage-v8`**：8 支自研 checker 迁移为 `tests/*.test.ts`，
  共享断言器 `tests/harness.ts`；覆盖率棘轮阈值（语句 52 / 分支 46 / 函数 54 / 行 54）
- **`size-limit` 体积预算**：主包 160 kB / three 分包 140 kB / 样式 12 kB（gzip），
  实测 117.47 / 99.17 / 6.81 kB（brotli）
- **CI 加 5 道闸门**：lint、format check、覆盖率、体积预算、覆盖率产物上传（保留 7 天）；
  并加 `concurrency` 自动取消旧构建
- **Dependabot**：npm 每周、GitHub Actions 每月；依赖分组（lint / 测试 / 构建三条链），
  对 `three` 只允许 patch（次版本常带行为变更，需人工确认）
- **首屏骨架屏**：写在 `index.html` 内联样式里，在 three.js 下载解析之前就能画出来
- **社区文件**：`CONTRIBUTING.md`、`CHANGELOG.md`、issue 模板（bug / feature / config）
- **`pnpm verify`**：一条命令跑完 CI 的全部检查
- **PLY / KITTI `.bin` 点云**：`core/io/ply.ts`（ascii + `binary_little_endian`，属性按名字查偏移）、
  `core/io/bin.ts`（裸 float32，按字节数自动判定每点 3 或 4 个数），由 `core/io/cloud.ts`
  按内容嗅探分发（PLY 魔数 / PCD 的 `FIELDS`+`DATA` 行，扩展名只作兜底）
- **`intensity` 贯通 + 标量着色**：`PointCloud.intensity` 由 PCD（`intensity`/`reflectance`/`i`）、
  PLY、`.bin` 三条链路填充；`core/geometry/colorize.ts` 提供 2%~98% 分位裁剪 + turbo/viridis
  色带，右侧「点云」段新增「强度」「高度」两个选项（3D 与三视图共用同一份取色）
- **WebGL 兜底**：监听 `webglcontextlost`/`webglcontextrestored`，失联时短路渲染、恢复后重建
  点云与全部框；`new WebGLRenderer` 失败不再白屏，而是在视口上给一条可读提示
- **浏览器用例 13 支**：新增 `color.mjs`（intensity 贯通 / 强度高度切换 / 真拖一个 `.ply` 进页面），
  文件输入改用 `data-role="cloud-input"` 选择器，不再绑死 `accept` 的取值

### Changed

- `pnpm test` 现在是「分层校验 + vitest + 覆盖率」，8 条 `test:core|domain|…` 脚本
  合并成 `pnpm test -- <name>`（`test:browser` 不变，仍复用本机 Edge）
- `.vue` 模板里多语句的事件处理器改成具名函数（`ToolRail.vue`）。原因：Prettier 折行后
  裸语句会被 Vue 编译器当单个表达式解析并编译失败，而 lint 与 `vue-tsc` 都不报
- `.gitignore` 补 `coverage/`
- **CI 拆成 verify → build → deploy 三段**：`build` 产出 `dist` 并跑体积预算，`deploy` 复用
  同一份产物；`.github/workflows/deploy.yml` 删除（以前部署会脱离 CI 再 build 一遍，产物没经过预算）

### Fixed

- **后台标签页会丢掉编辑权**：租约心跳原来只有 `setInterval`，浏览器把定时器节流到 6 秒以上
  就会超时被别的标签页接管。现在 `visibilitychange` 与 `pageshow` 都会立刻补心跳 / 重新抢租约
- **输入法打字会触发快捷键**：拼音组词阶段按 `v`/`h`/`n` 会把工具切走。守卫现在检查
  `isContentEditable`、`isComposing`（含 Safari 的 `keyCode 229`）与「有弹窗打开」
- **Esc 不能取消正在画/正在拖的框**：现在 Esc 会放弃本次拖拽（拖拽类的编辑会把起始快照
  提交回去，等价于回滚），且不会顺带清掉选中
- **坏 PCD 会触发巨额内存分配**：头部声明的点数按实际数据量钳制，非有限坐标跳过，
  全空数据给出明确错误；顺手修了 **ascii + rgb 字段的颜色恒为 0** 的老 bug
- **`OrthoView.vue` 的 `hoverId` 局部变量遮蔽同名 prop**（悬停高亮时灵时不灵，lint 抓到）
- **ascii PCD 的 rgb 打包**同时兼容 PCL 浮点写法与十进制整数写法
- **本地文件配对的正则写错**（`/\\.json$/` 多了一层转义，同名 JSON 永远配不上点云）——
  由 `p0` 断言抓到

### Tests

- 断言总数 **1056 项**（核心 227 / 4D 内核 247 / 状态层 47 / P0 81 / P2 预标注 39 /
  P3 回收 150 / P3 多任务 97 / P4 VLA 117 / 点云读取与着色 51），9 个文件全部通过
- 覆盖率实测：语句 53.0% / 分支 47.4% / 函数 54.7% / 行 54.4%，棘轮阈值同步上调到 52/46/54/54
  （分目录 core 93% / domain 86% / ports 100% / adapters 50%）
- 浏览器用例 13 支共 **363 项**全绿；顺手修掉 `gc` 用例里的偶发失败
  （手动清扫与「挂载后 1.5s 启动清扫」抢同一批垃圾，谁先跑谁收 —— 测试写法问题，已改成注入新垃圾再断言报数）

### Docs

- 新增 [`docs/12-review.md`](docs/12-review.md)：与 CVAT / Supervisely / Segments.ai 的十维对照、
  六大问题域、健壮性清单、P1/P2 路线图，以及「明确不做」的取舍
- README 的命令表补全（lint / format / size / verify），并说明覆盖率的正确读法；
  能力表补 PLY / `.bin` 与标量着色
- `docs/12-review.md` 增补「P1 第一批已落地」小节（§8b）与逐项状态表，并写清 e2e 未进 CI 的原因

## [0.1.0] - 2026-11-20

首个整理版本。能力清单见 README 第 2 节，这里只记里程碑：

- **3D 框标注**：CVAT 式三视图 + 3D 视口，两步画框，手柄编辑，`Shift+F` 自动拟合（PCA），
  多选 / 橡皮筋框选 / 整组平移，框内点云裁剪
- **点云 IO**：PCD（ascii / binary，含 `COUNT>1`、CRLF、rgb 打包）、XYZ；KITTI / DAIR-V2X /
  nuScenes / Waymo / SUSTechPOINTS 标注格式互转
- **逐点语义分割**：SemanticKITTI 官方 34 类 id、配色与 `learning_map`，高低 16 位编解码
- **4D 时序**：Track/关键帧真值内核、跨帧传播、轨迹插值、遮挡三态 + Kalman coasting、
  Kalman + Hungarian 关联、时序质检（ID 跳变 / 速度突变 / 抖动 / 断裂）与健康分
- **多任务**：框 / 语义 / 占据 / 光流 / lane / VLA 六类任务注册表；占据网格与光流场是真值派生，
  并与框做 I1/I2/I3 一致性校验；`.occ` 导出 + `scripts/occ2npz.py`
- **VLA**：指令段 / 动作通道 / 对齐校验 11 条规则 / JSONL 互通 + `scripts/vla_check.py`
- **持久化与性能**：IndexedDB v3 分段存储、内容寻址 blob + 引用计数 + GC 审计、
  跨标签页租约、帧缓存全局 LRU/LFU/hybrid、大序列懒加载、体素下采样 + 距离 LOD
- **预标注**：3 个 provider（演示用确定性 mock / http / 本地文件）+ IoU 关联 + 四种合并策略 + 复核闸门
- **相机**：投影与 k1k2p1p2k3 畸变、前视分屏、运镜（样条）+ WebM 录制
