# ② 点云数据格式 PCD

> 配套源码：`src/core/io/pcd.ts`

这一篇讲清楚"点云文件里到底存了什么"，以及怎么把它解析成程序能用的数据。

---

## 1. 点云是什么

点云（Point Cloud）是三维空间中的一组采样点，每个点通常包含：

- **坐标** x, y, z（必备）
- **强度** intensity（激光反射强度，可选）
- **颜色** rgb（可选，多由彩色相机或 RGB-D 传感器生成）

激光雷达（LiDAR）扫描一圈，就能得到几十万到上百万个点。它们是自动驾驶感知算法最重要的输入之一。

---

## 2. PCD 文件格式

PCD 是 PCL（Point Cloud Library）定义的格式。结构是：**文本头 + 数据块**。

```
# .PCD v0.7 - Point Cloud Data file format
VERSION 0.7
FIELDS x y z intensity
SIZE 4 4 4 4
TYPE F F F F
COUNT 1 1 1 1
WIDTH 100000
HEIGHT 1
VIEWPOINT 0 0 0 1 0 0 0
POINTS 100000
DATA binary
<binary data...>
```

逐行解释头部字段：

| 字段 | 含义 |
|---|---|
| `FIELDS` | 每个点有哪些属性：x/y/z/intensity/rgb... |
| `SIZE` | 每个属性占多少字节。float 通常 4 字节 |
| `TYPE` | 类型：`F`=浮点, `U`=无符号整数, `I`=有符号整数 |
| `COUNT` | 每个属性有几个分量（一般 1；法线 nx/ny/nz 会合并） |
| `WIDTH`/`HEIGHT` | 点云尺寸。无序点云 WIDTH=点数、HEIGHT=1 |
| `POINTS` | 点的总数 |
| `DATA` | 数据编码方式：`ascii` / `binary` / `binary_compressed` |

---

## 3. 三种编码方式

### 3.1 ASCII

每个点一行，用空格分隔数值：

```
0.1 0.2 1.5 0.8
0.3 0.1 1.4 0.6
```

优点：人能直接看懂、方便调试。缺点：文件巨大（浮点数全用字符串存）。

### 3.2 Binary

按字段类型，用紧凑的二进制存。一个点占 `SIZE × COUNT` 之和字节（上面例子是 16 字节）。

优点：文件小、读写快，实际项目最常用。解析关键是用 `DataView` 按偏移和类型读取：

```ts
const view = new DataView(buffer)
const x = view.getFloat32(rowStart + offsets.x, true)  // true = little-endian
```

### 3.3 Binary Compressed

压缩编码，最省空间但解析复杂（需要 LZF 解压）。教学版暂未支持，遇到时可先用 PCL 工具转换。

---

## 4. 解析器的实现思路（`pcd.ts`）

```
1. 把文件开头的字节解码成文本，逐行解析头部
2. 根据 FIELDS/SIZE/COUNT 算出每个字段的字节偏移 offset
3. 累加得到"每个点占多少字节" pointStep
4. 找到 DATA 行之后的位置，作为数据区起点
5.
   ascii  → 按空白切分 token，每 fields.length 个一组
   binary → 从数据区起点开始，每次跳 pointStep 字节，
            用 DataView 按 offset + 类型读出 x/y/z
6. 输出 Float32Array
```

**关键细节**：`dataOffset`（数据区起始字节）的计算。因为头部是纯 ASCII，可以累加每行的字符数 +1（换行符）得到字节偏移。这是文本头 + 二进制数据混合格式的一个经典处理技巧。

---

## 5. 为什么用 Float32Array 而不是对象数组

一个 10 万点的点云：

- 对象数组 `[{x,y,z}, ...]`：每个对象有哈希开销，可能占用几十 MB。
- `Float32Array(300000)`：固定 1.2 MB，连续内存，还能直接传给 GPU。

点云处理的黄金法则：**数据尽量保持为紧凑的 typed array，避免不必要的对象化和拷贝**。

---

## 6. 动手验证

1. 下载原仓库的示例 PCD（`data/example/pcd/000970.pcd`，约 3MB），用 `导入 PCD` 按钮加载，看状态栏显示的点数。
2. 用文本编辑器打开一个 ASCII 格式的 PCD（可把 binary 的转换一下），对照头部字段理解结构。
3. 思考：如果 PCD 里字段顺序是 `z y x`（而不是 x y z），解析器要怎么改？（提示：靠 `fields.indexOf('x')` 定位偏移，而不是写死顺序——我们的代码已经这么做了）
