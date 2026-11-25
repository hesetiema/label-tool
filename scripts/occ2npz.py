#!/usr/bin/env python3
"""
把 `occupancy.occ` 转成训练侧能直接吃的 npz

用法：
    python3 scripts/occ2npz.py sample-occupancy.occ -o sample-occupancy.npz
    python3 scripts/occ2npz.py sample-occupancy.occ --dense -o sample-occupancy.npz

为什么只在 Python 侧提供转换：
    浏览器里导出"稀疏索引 + RLE"是最省存储的形态；训练侧要的是张量。
    中间这层转换属于数据工程，不该塞进标注工具的构建链（引一个打包库就为了
    zip 几百 KB 不划算），所以留一个只依赖 numpy 的脚本。

.occ 格式（与 src/domain/derive/occupancy.ts 的 encodeOccBundle 一致，小端）：
    magic   'OCB1'          4 字节
    u32     header 长度
    header  JSON             { spec: {...}, frames: [{frame, offset, bytes}] }
    载荷    每帧一段 RLE

每帧 RLE：
    u32 magic 'OCC1' | u32 frame | u16 specKey 长度 | specKey | u32 runCount |
    runCount × (u32 start | u32 length | u8 label)

输出（默认稀疏，CSR 风格，帧间共享一份数组）：
    frame_ids   int32[n]
    indptr      int64[n+1]      第 i 帧的体素在 indices[indptr[i]:indptr[i+1]]
    indices     uint32[total]   线性索引（x 最快）
    labels      uint8[total]    类别下标，对应 class_ids
    class_ids   unicode[k]
    resolution  float32
    origin      float32[3]
    size        int32[3]

    `--dense` 额外输出 `occ` uint8[n, nx, ny, nz]，值 = 类别下标 + 1，0 表示未占用。
    500 帧 × 200×200×16 的 dense 是 320MB，非必要不要开。
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

try:
    import numpy as np
except ImportError:  # pragma: no cover
    sys.exit("需要 numpy：pip install numpy")


RLE_MAGIC = 0x4F434331  # 'OCC1'


def read_bundle(path: Path):
    raw = path.read_bytes()
    if len(raw) < 12 or raw[:4] != b"OCB1":
        raise ValueError(f"{path} 不是 .occ 文件（magic 不符）")
    (header_len,) = struct.unpack_from("<I", raw, 4)
    header = json.loads(raw[8:8 + header_len].decode("utf-8"))
    base = 8 + header_len
    frames = []
    for entry in header["frames"]:
        start = base + entry["offset"]
        frames.append(decode_rle(raw[start:start + entry["bytes"]]))
    return header["spec"], frames


def decode_rle(buf: bytes):
    magic, frame, spec_len = struct.unpack_from("<IIH", buf, 0)
    if magic != RLE_MAGIC:
        raise ValueError(f"第 {frame} 帧的 RLE magic 不符")
    p = 10 + spec_len
    (run_count,) = struct.unpack_from("<I", buf, p)
    p += 4
    if p + run_count * 9 != len(buf):
        raise ValueError(f"第 {frame} 帧 RLE 长度不符：{run_count} 段 vs {len(buf) - p} 字节")
    total = 0
    runs = []
    for _ in range(run_count):
        start, length, label = struct.unpack_from("<IIB", buf, p)
        p += 9
        runs.append((start, length, label))
        total += length
    indices = np.empty(total, dtype=np.uint32)
    labels = np.empty(total, dtype=np.uint8)
    at = 0
    for start, length, label in runs:
        indices[at:at + length] = np.arange(start, start + length, dtype=np.uint32)
        labels[at:at + length] = label
        at += length
    return {"frame": frame, "indices": indices, "labels": labels}


def main() -> int:
    ap = argparse.ArgumentParser(description="把 .occ 转成 npz")
    ap.add_argument("source", type=Path, help="导出的 .occ 文件")
    ap.add_argument("-o", "--out", type=Path, help="输出 npz（默认同名）")
    ap.add_argument("--dense", action="store_true", help="额外输出稠密张量（占内存/磁盘）")
    args = ap.parse_args()

    spec, frames = read_bundle(args.source)
    frames.sort(key=lambda f: f["frame"])
    counts = np.array([len(f["indices"]) for f in frames], dtype=np.int64)
    indptr = np.concatenate([[0], np.cumsum(counts)]).astype(np.int64)
    payload = {
        "frame_ids": np.array([f["frame"] for f in frames], dtype=np.int32),
        "indptr": indptr,
        "indices": np.concatenate([f["indices"] for f in frames]) if frames else np.empty(0, np.uint32),
        "labels": np.concatenate([f["labels"] for f in frames]) if frames else np.empty(0, np.uint8),
        # 用定长 unicode 而不是 dtype=object：后者要 allow_pickle=True 才能读回来，
        # 训练侧加载 npz 时最不想看到的就是"还得多传一个参数"
        "class_ids": np.array(spec["classIds"], dtype="<U32"),
        "resolution": np.float32(spec["resolution"]),
        "origin": np.array([spec["origin"][k] for k in ("x", "y", "z")], dtype=np.float32),
        "size": np.array([spec["size"][k] for k in ("x", "y", "z")], dtype=np.int32),
    }

    if args.dense:
        nx, ny, nz = (int(v) for v in payload["size"])
        occ = np.zeros((len(frames), nx, ny, nz), dtype=np.uint8)
        res = float(spec["resolution"])
        # 占据帧存的是"哪些格是满的"，稠密化时值 = 类别下标 + 1 是为了让 0 空出来表示"未占用"，
        # 否则 Car（下标 0）和"没有东西"会撞成同一个值
        for i, f in enumerate(frames):
            occ[i].reshape(-1)[f["indices"]] = f["labels"].astype(np.uint8) + 1
        payload["occ"] = occ
        print(f"稠密张量 {occ.shape} = {occ.nbytes / 1048576:.1f} MB")

    out = args.out or args.source.with_suffix(".npz")
    np.savez_compressed(out, **payload)
    print(f"已写出 {out}：{len(frames)} 帧 / {int(payload['indices'].size)} 个占用体素 / "
          f"{out.stat().st_size / 1024:.1f} KB")
    print(f"class_ids = {list(spec['classIds'])}")
    # 回到稀疏：把 indices 直接当作 flat 下标用，避免下游自己算 x-major 的换算
    print("稀疏布局：第 i 帧 = indices[indptr[i]:indptr[i+1]]，"
          "flat = ix + nx*(iy + ny*iz)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
