#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nuScenes mini -> point-cloud-label-studio 格式转换器

把 nuScenes 原始数据转成工具能直接加载的格式：
  1) LIDAR_TOP 的 .bin 点云 (x,y,z,intensity float32) -> 本工具的 binary PCD
  2) sample_annotation 的 3D 框 -> SUSTechPOINTS 兼容 label JSON (psr/obj_type/obj_id/vertices)
  3) calibrated_sensor + camera_intrinsic -> 工具的 extrinsic(4x4行主序) + intrinsic(3x3行主序)
  4) CAM_FRONT 的 .jpg -> 相机对照图

同时做坐标变换：nuScenes 是右手系 z-up，与我们工具 (KITTI/SUSTechPOINTS 风格) 一致，
但 nuScenes 框用的是四元数 + [w,l,h] 顺序，需要转成 yaw + scale{x=length,y=width,z=height}。

纯标准库实现，无需 numpy/scipy。
"""
import os
import sys
import json
import math
import struct
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'datasets', 'nuscenes', 'v1.0-mini')
OUT = os.path.join(ROOT, 'public', 'data', 'nuscenes')

# 只转换前 N 个 sample（每个约 0.5s），够学习用，避免生成几百 MB 文件
MAX_SAMPLES = int(os.environ.get('MAX_SAMPLES', '12'))

# nuScenes 类别 -> 工具类别（工具目前支持 Car/Truck/Pedestrian/Rider/Cyclist）
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
    with open(os.path.join(SRC, 'v1.0-mini', name), 'r', encoding='utf-8') as f:
        return json.load(f)


def quat_to_yaw(rotation):
    """四元数 [w,x,y,z] -> 绕 z 轴的 yaw。nuScenes 框局部 x 轴为车头前进方向。"""
    w, x, y, z = rotation
    # x 轴 (1,0,0) 经四元数旋转后的方向
    tx = 2 * (y * 0 - z * 0)  # 2*(q_vec × v).x = 2*(y*vz - z*vy), v=(1,0,0)
    ty = 2 * (z * 1 - x * 0)
    tz = 2 * (x * 0 - y * 1)
    dx = 1 + w * tx + (y * tz - z * ty)
    dy = 0 + w * ty + (z * tx - x * tz)
    return math.atan2(dy, dx)


def quat_to_matrix(q):
    """四元数 [w,x,y,z] -> 3x3 旋转矩阵（行主序 9 元素）"""
    w, x, y, z = q
    return [
        1 - 2*(y*y + z*z), 2*(x*y - w*z),   2*(x*z + w*y),
        2*(x*y + w*z),   1 - 2*(x*x + z*z), 2*(y*z - w*x),
        2*(x*z - w*y),   2*(y*z + w*x),   1 - 2*(x*x + y*y),
    ]


def mat_mul(a, b, n):
    """n×n 矩阵乘法（行主序）"""
    out = [0.0] * (n*n)
    for i in range(n):
        for k in range(n):
            if a[i*n+k] == 0:
                continue
            for j in range(n):
                out[i*n+j] += a[i*n+k] * b[k*n+j]
    return out


def compose(rot_quat, translation):
    """位姿 -> 4x4 齐次变换矩阵（世界系位姿）"""
    R = quat_to_matrix(rot_quat)
    M = [0.0]*16
    for i in range(3):
        for j in range(3):
            M[i*4+j] = R[i*3+j]
        M[i*4+3] = translation[i]
    M[15] = 1.0
    return M


def inverse_rigid(M):
    """刚体变换 4x4 求逆：R^T 与 -R^T·t"""
    out = [0.0]*16
    for i in range(3):
        for j in range(3):
            out[i*4+j] = M[j*4+i]  # 转置
    for i in range(3):
        s = 0.0
        for j in range(3):
            s += out[i*4+j] * M[j*4+3]
        out[i*4+3] = -s
    out[15] = 1.0
    return out


def transform_point(M, p):
    """4x4 矩阵作用到 3D 点"""
    x, y, z = p
    return (
        M[0]*x + M[1]*y + M[2]*z + M[3],
        M[4]*x + M[5]*y + M[6]*z + M[7],
        M[8]*x + M[9]*y + M[10]*z + M[11],
    )


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


def bin_to_pcd(src_bin, dst_pcd):
    """nuScenes lidar bin (x,y,z,intensity,...) -> binary PCD, 每点 4 float (x,y,z,intensity)"""
    with open(src_bin, 'rb') as f:
        data = f.read()
    # nuScenes LIDAR_TOP: 每点 5 个 float32 (x,y,z,intensity,ring)，也有 4 个的版本
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
    for i in range(n):
        off = i*fi*4
        x, y, z, intensity = struct.unpack_from('<4f', data, off)
        points += struct.pack('<4f', x, y, z, intensity)
    with open(dst_pcd, 'wb') as f:
        f.write(header)
        f.write(points)
    return n


def main():
    if not os.path.isdir(SRC):
        print(f'ERROR: 源目录不存在: {SRC}')
        print('请先解压 v1.0-mini.tgz 到 datasets/nuscenes/')
        sys.exit(1)
    os.makedirs(OUT, exist_ok=True)

    sample = load_json('sample.json')
    sample_data = load_json('sample_data.json')
    ann = load_json('sample_annotation.json')
    calib_sensor = load_json('calibrated_sensor.json')
    ego_pose = load_json('ego_pose.json')

    by_token = {d['token']: d for d in sample_data}
    ego_by_token = {e['token']: e for e in ego_pose}
    calib_by_token = {c['token']: c for c in calib_sensor}
    ann_by_sample = {}
    for a in ann:
        ann_by_sample.setdefault(a['sample_token'], []).append(a)

    # 有序 sample（按 timestamp）
    samples = sorted(sample, key=lambda s: s['timestamp'])[:MAX_SAMPLES]

    index = []
    for idx, s in enumerate(samples):
        token = s['token']
        # 找到该 sample 的 LIDAR_TOP 与 CAM_FRONT
        lidar = next((d for d in sample_data if d['sample_token'] == token and d['channel'] == 'LIDAR_TOP'), None)
        cam = next((d for d in sample_data if d['sample_token'] == token and d['channel'] == 'CAM_FRONT'), None)
        if not lidar or not cam:
            continue

        stem = f'ns_{idx:03d}'
        # ---- 点云 ----
        lidar_src = os.path.join(SRC, lidar['filename'].replace('samples/', 'samples/'))
        if not os.path.exists(lidar_src):
            lidar_src = os.path.join(SRC, lidar['filename'])
        pcd_dst = os.path.join(OUT, stem + '.pcd')
        if not os.path.exists(pcd_dst):
            npts = bin_to_pcd(lidar_src, pcd_dst)
        else:
            npts = 0

        # ---- 坐标变换：世界 -> lidar ----
        ego = ego_by_token[lidar['ego_pose_token']]
        cs_lidar = calib_by_token[lidar['calibrated_sensor_token']]
        # world -> ego -> lidar
        M_ego_to_world = compose(ego['rotation'], ego['translation'])
        M_lidar_to_ego = compose(cs_lidar['rotation'], cs_lidar['translation'])
        M_lidar_to_world = mat_mul(M_ego_to_world, M_lidar_to_ego, 4)
        M_world_to_lidar = inverse_rigid(M_lidar_to_world)

        # ---- 标注框 -> label JSON ----
        labels = []
        for a in ann_by_sample.get(token, []):
            cat = CATEGORY_MAP.get(a['category_name'])
            if not cat:
                continue
            # 中心转到 lidar 系
            center = transform_point(M_world_to_lidar, a['translation'])
            # 只保留 ego 前方一定范围内的框
            if abs(center[0]) > 60 or abs(center[1]) > 60:
                continue
            # 尺寸 nuScenes [w,l,h] -> 工具 {x=length, y=width, z=height}
            w, l, h = a['size']
            scale = [l, w, h]
            # yaw：把框的世界朝向转到 lidar 系后取 z 旋转
            R_box_world = quat_to_matrix(a['rotation'])
            R_world_to_lidar_3 = [M_world_to_lidar[i*4+j] for i in range(3) for j in range(3)]
            R_box_lidar = mat_mul(R_world_to_lidar_3, R_box_world, 3)
            yaw = math.atan2(R_box_lidar[1], R_box_lidar[0])  # 局部 x 轴在 lidar 系的方向
            pos = {'x': round(center[0],4), 'y': round(center[1],4), 'z': round(center[2],4)}
            scl = {'x': round(scale[0],4), 'y': round(scale[1],4), 'z': round(scale[2],4)}
            labels.append({
                'psr': {'position': pos, 'scale': scl, 'rotation': {'x':0,'y':0,'z':round(yaw,5)}},
                'obj_type': cat,
                'obj_id': a['instance_token'][:8],
                'vertices': build_vertex_list(center, scale, yaw),
            })
        with open(os.path.join(OUT, stem + '.json'), 'w', encoding='utf-8') as f:
            json.dump(labels, f, ensure_ascii=False)

        # ---- 相机标定：lidar -> camera 外参 + 内参 ----
        ego_c = ego_by_token[cam['ego_pose_token']]
        cs_cam = calib_by_token[cam['calibrated_sensor_token']]
        M_cam_to_world = compose(ego_c['rotation'], ego_c['translation'])
        M_cam_to_world = mat_mul(M_cam_to_world, compose(cs_cam['rotation'], cs_cam['translation']), 4)
        M_world_to_cam = inverse_rigid(M_cam_to_world)
        M_lidar_to_cam = mat_mul(M_world_to_cam, M_lidar_to_world, 4)
        intrinsic3 = cs_cam['camera_intrinsic']
        extrinsic = [round(v,6) for v in M_lidar_to_cam]
        intrinsic = [round(v,6) for row in intrinsic3 for v in row]
        with open(os.path.join(OUT, stem + '_calib.json'), 'w', encoding='utf-8') as f:
            json.dump({'extrinsic': extrinsic, 'intrinsic': intrinsic}, f)

        # ---- 相机图像 ----
        cam_src = os.path.join(SRC, cam['filename'])
        cam_dst = os.path.join(OUT, stem + '.jpg')
        if os.path.exists(cam_src) and not os.path.exists(cam_dst):
            shutil.copyfile(cam_src, cam_dst)

        index.append({
            'id': stem,
            '点云': stem + '.pcd',
            '标注': stem + '.json',
            '标定': stem + '_calib.json',
            '图像': stem + '.jpg' if os.path.exists(cam_dst) else None,
            '点数': npts if npts else 0,
            '框数': len(labels),
            '时间戳': s['timestamp'],
        })
        print(f'[{idx+1}/{len(samples)}] {stem}: {npts} 点, {len(labels)} 框')

    with open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print(f'\n完成：{len(index)} 帧已写入 {OUT}')


if __name__ == '__main__':
    main()
