#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nuScenes mini -> point-cloud-label-studio 格式转换器

支持两种坐标系模式（环境变量 MODE 或命令行 --mode）：
  lidar（默认）：所有帧保持在各自 ego/lidar 系 —— 适合逐帧对照相机图
  world        ：用 ego_pose 把每帧点云变换到统一世界系，标注框用官方世界坐标
                 —— 这才是真正的 4D-BEV：静止背景重合、运动目标拖出轨迹

【世界系对齐原理 —— 4D-BEV 的地基】
nuScenes 每帧点云存于 lidar 局部系。要对齐到世界系：
    p_world = R_ego · (R_lidar·p_lidar + t_lidar) + t_ego
其中 ego_pose 给 (R_ego, t_ego)，calibrated_sensor 给 (R_lidar, t_lidar)。
不做这一步，静止物体在 ego 系里每帧都"后退"，会被误标成运动目标。

输出：
  1) LIDAR_TOP .bin -> binary PCD（world 模式下顶点已变换到世界系）
  2) sample_annotation 3D 框 -> SUSTechPOINTS 兼容 label JSON
     world 模式直接用 a['translation']（世界系），并带 visibility 字段
  3) calibrated_sensor + camera_intrinsic -> extrinsic + intrinsic
  4) CAM_FRONT .jpg -> 相机对照图

纯标准库实现，无需 numpy/scipy。
"""
import os
import sys
import json
import math
import struct
import shutil
import argparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATASET = os.path.join(ROOT, 'datasets', 'nuscenes')
SRC = os.path.join(DATASET, 'v1.0-mini')  # 元数据 json 所在目录（实测结构）

# nuScenes visibility_token -> 我们的遮挡状态
# 1=most occluded (0-25% visible), 4=fully visible
VISIBILITY_MAP = {
    '1': 'occluded', '2': 'occluded',
    '3': 'visible', '4': 'visible',
}

MAX_SAMPLES = int(os.environ.get('MAX_SAMPLES', '12'))

CATEGORY_MAP = {
    'vehicle.car': 'Car',
    'vehicle.truck': 'Truck',
    'vehicle.construction': 'Truck',
    'vehicle.bus.rigid': 'Truck',
    'vehicle.bus.bendy': 'Truck',
    'human.pedestrian.adult': 'Pedestrian',
    'human.pedestrian.child': 'Pedestrian',
    'human.pedestrian.construction_worker': 'Pedestrian',
    'human.pedestrian.police_officer': 'Pedestrian',
    'vehicle.motorcycle': 'Rider',
    'human.pedestrian.personal_mobility': 'Rider',
    'vehicle.bicycle': 'Cyclist',
}
DEFAULT_SIZE = {
    'Car': [4.5, 1.8, 1.6], 'Truck': [8.0, 2.5, 3.0],
    'Pedestrian': [0.7, 0.7, 1.75], 'Rider': [2.0, 0.8, 1.7],
    'Cyclist': [1.8, 0.6, 1.7],
}


def load_json(name):
    path = os.path.join(SRC, name)
    if not os.path.exists(path):
        path = os.path.join(SRC, 'v1.0-mini', name)  # 兼容嵌套结构
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def dataset_path(rel):
    """把 sample_data.filename (相对路径) 解析成绝对路径"""
    p = os.path.join(DATASET, rel)
    if os.path.exists(p):
        return p
    return os.path.join(SRC, rel)


# ---------- 数学工具（4x4 行主序） ----------

def quat_to_matrix(q):
    """四元数 [w,x,y,z] -> 3x3 旋转矩阵（行主序 9 元素）"""
    w, x, y, z = q
    return [
        1 - 2*(y*y + z*z), 2*(x*y - w*z),   2*(x*z + w*y),
        2*(x*y + w*z),   1 - 2*(x*x + z*z), 2*(y*z - w*x),
        2*(x*z - w*y),   2*(y*z + w*x),   1 - 2*(x*x + y*y),
    ]


def quat_to_yaw_3(m3):
    """从 3x3 旋转矩阵取局部 x 轴方向的 yaw"""
    return math.atan2(m3[1], m3[0])


def mat_mul(a, b, n):
    out = [0.0] * (n*n)
    for i in range(n):
        for k in range(n):
            if a[i*n+k] == 0:
                continue
            for j in range(n):
                out[i*n+j] += a[i*n+k] * b[k*n+j]
    return out


def compose(rot_quat, translation):
    """位姿 -> 4x4 齐次变换矩阵"""
    R = quat_to_matrix(rot_quat)
    M = [0.0]*16
    for i in range(3):
        for j in range(3):
            M[i*4+j] = R[i*3+j]
        M[i*4+3] = translation[i]
    M[15] = 1.0
    return M


def inverse_rigid(M):
    out = [0.0]*16
    for i in range(3):
        for j in range(3):
            out[i*4+j] = M[j*4+i]
    for i in range(3):
        s = 0.0
        for j in range(3):
            s += out[i*4+j] * M[j*4+3]
        out[i*4+3] = -s
    out[15] = 1.0
    return out


def transform_point(M, p):
    x, y, z = p
    return (
        M[0]*x + M[1]*y + M[2]*z + M[3],
        M[4]*x + M[5]*y + M[6]*z + M[7],
        M[8]*x + M[9]*y + M[10]*z + M[11],
    )


def rotation3(M4):
    return [M4[i*4+j] for i in range(3) for j in range(3)]


def build_vertex_list(position, scale, yaw):
    """生成 8 角点，顺序与工具 boxToVertices 完全一致"""
    hx, hy, hz = scale[0]/2, scale[1]/2, scale[2]/2
    local = [
        (hx,-hy,-hz),(hx,hy,-hz),(hx,hy,hz),(hx,-hy,hz),
        (-hx,-hy,-hz),(-hx,hy,-hz),(-hx,hy,hz),(-hx,-hy,hz),
    ]
    c, s = math.cos(yaw), math.sin(yaw)
    out = []
    for lx, ly, lz in local:
        rx, ry = lx*c - ly*s, lx*s + ly*c
        out.extend([position[0]+rx, position[1]+ry, position[2]+lz, 1])
    return out


def bin_to_pcd(src_bin, dst_pcd, transform=None, origin=None):
    """
    nuScenes lidar bin (x,y,z,intensity,...) -> binary PCD。
    @param transform 4x4 矩阵，若给定则把每点变换（world 模式用）
    @param origin    世界系原点偏移 [ox,oy,oz]，变换后减去，避免坐标过大损失精度
    """
    with open(src_bin, 'rb') as f:
        data = f.read()
    fi = 5 if len(data) % 20 == 0 else 4
    n = len(data) // (fi*4)
    header = (
        "# .PCD v0.7 - converted from nuScenes\n"
        "VERSION 0.7\n"
        "FIELDS x y z intensity\n"
        "SIZE 4 4 4 4\n"
        "TYPE F F F F\n"
        "COUNT 1 1 1 1\n"
        f"WIDTH {n}\nHEIGHT 1\n"
        "VIEWPOINT 0 0 0 1 0 0 0\n"
        f"POINTS {n}\n"
        "DATA binary\n"
    ).encode('ascii')
    points = bytearray()
    ox = origin[0] if origin else 0.0
    oy = origin[1] if origin else 0.0
    oz = origin[2] if origin else 0.0
    for i in range(n):
        off = i*fi*4
        x, y, z, intensity = struct.unpack_from('<4f', data, off)
        if transform is not None:
            x, y, z = transform_point(transform, (x, y, z))
        points += struct.pack('<4f', x-ox, y-oy, z-oz, intensity)
    with open(dst_pcd, 'wb') as f:
        f.write(header)
        f.write(points)
    return n


def main():
    ap = argparse.ArgumentParser(description='nuScenes -> 标注工具格式转换')
    ap.add_argument('--mode', choices=['lidar', 'world'], default=os.environ.get('MODE', 'lidar'),
                    help='lidar=逐帧局部系; world=ego-pose 对齐到统一世界系（4D-BEV）')
    ap.add_argument('--samples', type=int, default=MAX_SAMPLES, help='转换前 N 个关键帧')
    args = ap.parse_args()
    world = args.mode == 'world'

    if not os.path.isdir(SRC):
        print(f'ERROR: 源目录不存在: {SRC}')
        sys.exit(1)

    OUT = os.path.join(ROOT, 'public', 'data', 'nuscenes_world' if world else 'nuscenes')
    os.makedirs(OUT, exist_ok=True)

    sample = load_json('sample.json')
    sample_data = load_json('sample_data.json')
    ann = load_json('sample_annotation.json')
    calib_sensor = load_json('calibrated_sensor.json')
    ego_pose = load_json('ego_pose.json')
    sensor = load_json('sensor.json')

    by_token = {d['token']: d for d in sample_data}
    ego_by_token = {e['token']: e for e in ego_pose}
    calib_by_token = {c['token']: c for c in calib_sensor}
    sensor_by_token = {s['token']: s for s in sensor}
    ann_by_sample = {}
    for a in ann:
        ann_by_sample.setdefault(a['sample_token'], []).append(a)

    # 有序 keyframe sample（sample.json 每项都是关键帧）
    samples = sorted(sample, key=lambda s: s['timestamp'])[:args.samples]

    # 找 LIDAR_TOP / CAM_FRONT 的 sample_data：镜像无 channel 字段，用 filename 判定
    def find_sd(sample_token, channel):
        return next(
            (d for d in sample_data
             if d['sample_token'] == sample_token
             and d.get('is_key_frame')
             and f'__{channel}__' in d['filename']),
            None,
        )

    # world 模式：选第一帧 ego 位置作为局部原点，避免世界坐标 ~400/1179 过大
    origin = None
    if world and samples:
        first_sd = find_sd(samples[0]['token'], 'LIDAR_TOP')
        if first_sd:
            origin = ego_by_token[first_sd['ego_pose_token']]['translation']

    index = []
    for idx, s in enumerate(samples):
        token = s['token']
        lidar = find_sd(token, 'LIDAR_TOP')
        cam = find_sd(token, 'CAM_FRONT')
        if not lidar:
            continue

        stem = f'ns_{idx:03d}'

        # ---- 坐标系变换矩阵 ----
        ego = ego_by_token[lidar['ego_pose_token']]
        cs_lidar = calib_by_token[lidar['calibrated_sensor_token']]
        M_ego_to_world = compose(ego['rotation'], ego['translation'])
        M_lidar_to_ego = compose(cs_lidar['rotation'], cs_lidar['translation'])
        M_lidar_to_world = mat_mul(M_ego_to_world, M_lidar_to_ego, 4)
        M_world_to_lidar = inverse_rigid(M_lidar_to_world)

        # ---- 点云 ----
        lidar_src = dataset_path(lidar['filename'])
        pcd_dst = os.path.join(OUT, stem + '.pcd')
        if not os.path.exists(lidar_src):
            print(f'  [警告] 跳过 {stem}: 点云不存在 {lidar_src}')
            continue
        if not os.path.exists(pcd_dst):
            npts = bin_to_pcd(
                lidar_src, pcd_dst,
                transform=M_lidar_to_world if world else None,
                origin=origin,
            )
        else:
            with open(pcd_dst, 'rb') as f:
                head = f.read(400).decode('ascii', 'ignore')
            npts = 0
            for line in head.splitlines():
                if line.startswith('POINTS '):
                    npts = int(line.split()[1]); break

        # ---- 标注框 ----
        labels = []
        for a in ann_by_sample.get(token, []):
            cat = CATEGORY_MAP.get(a['category_name'] if 'category_name' in a else '')
            # 镜像 annotation 无 category_name，从 instance 反查；这里用 size 启发式兜底
            if not cat:
                w, l, h = a['size']
                if h < 1.0 and l < 1.2:
                    cat = 'Pedestrian'
                elif l > 7:
                    cat = 'Truck'
                elif l < 2.5 and w < 1.0:
                    cat = 'Cyclist'
                else:
                    cat = 'Car'
            w, l, h = a['size']
            scale = [l, w, h]

            if world:
                # 世界系：直接用官方 translation，减去局部原点
                center = (
                    a['translation'][0] - (origin[0] if origin else 0),
                    a['translation'][1] - (origin[1] if origin else 0),
                    a['translation'][2] - (origin[2] if origin else 0),
                )
                R_box = quat_to_matrix(a['rotation'])
                yaw = quat_to_yaw_3(R_box)
            else:
                center = transform_point(M_world_to_lidar, a['translation'])
                if abs(center[0]) > 60 or abs(center[1]) > 60:
                    continue
                R_box_world = quat_to_matrix(a['rotation'])
                R_box_lidar = mat_mul(rotation3(M_world_to_lidar), R_box_world, 3)
                yaw = quat_to_yaw_3(R_box_lidar)

            vis = VISIBILITY_MAP.get(str(a.get('visibility_token', '4')), 'visible')
            pos = {'x': round(center[0],4), 'y': round(center[1],4), 'z': round(center[2],4)}
            scl = {'x': round(scale[0],4), 'y': round(scale[1],4), 'z': round(scale[2],4)}
            raw = {
                'psr': {'position': pos, 'scale': scl, 'rotation': {'x':0,'y':0,'z':round(yaw,5)}},
                'obj_type': cat,
                'obj_id': a['instance_token'][:8],
                'vertices': build_vertex_list(center, scale, yaw),
            }
            if vis != 'visible':
                raw['visibility'] = vis  # 扩展字段：遮挡目标
            labels.append(raw)

        with open(os.path.join(OUT, stem + '.json'), 'w', encoding='utf-8') as f:
            json.dump(labels, f, ensure_ascii=False)

        # ---- 相机标定（lidar -> camera 外参 + 内参）----
        firstCalib = None
        firstImage = None
        if cam:
            ego_c = ego_by_token[cam['ego_pose_token']]
            cs_cam = calib_by_token[cam['calibrated_sensor_token']]
            M_cam_to_world = mat_mul(
                compose(ego_c['rotation'], ego_c['translation']),
                compose(cs_cam['rotation'], cs_cam['translation']), 4)
            M_world_to_cam = inverse_rigid(M_cam_to_world)
            M_lidar_to_cam = mat_mul(M_world_to_cam, M_lidar_to_world, 4)
            # world 模式：点云在世界系，相机外参应为 world -> cam
            ext = M_world_to_cam if world else M_lidar_to_cam
            intrinsic3 = cs_cam['camera_intrinsic']
            firstCalib = {'extrinsic': [round(v,6) for v in ext],
                          'intrinsic': [round(v,6) for row in intrinsic3 for v in row]}
            with open(os.path.join(OUT, stem + '_calib.json'), 'w', encoding='utf-8') as f:
                json.dump(firstCalib, f)
            cam_src = dataset_path(cam['filename'])
            cam_dst = os.path.join(OUT, stem + '.jpg')
            if os.path.exists(cam_src) and not os.path.exists(cam_dst):
                shutil.copyfile(cam_src, cam_dst)
            if os.path.exists(cam_dst):
                firstImage = stem + '.jpg'

        index.append({
            'id': stem,
            '点云': stem + '.pcd',
            '标注': stem + '.json',
            '标定': stem + '_calib.json' if firstCalib else None,
            '图像': firstImage,
            '点数': npts,
            '框数': len(labels),
            '时间戳': s['timestamp'],
        })
        print(f'[{idx+1}/{len(samples)}] {stem}: {npts} 点, {len(labels)} 框, {sum(1 for l in labels if "visibility" in l)} 遮挡')

    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print(f'\n完成：{len(index)} 帧已写入 {OUT}（mode={args.mode}）')


if __name__ == '__main__':
    main()
