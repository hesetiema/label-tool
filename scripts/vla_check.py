#!/usr/bin/env python3
"""
独立回读校验 `*-vla.jsonl`

用法：
    python3 scripts/vla_check.py sample-vla.jsonl
    python3 scripts/vla_check.py sample-vla.jsonl --quiet

为什么需要它：
    标注工具的导出闸门在浏览器里跑，训练侧拿到文件时**没法验证**那份闸门是不是
    真的生效了（比如"未确认的模型指令没被导出"）。这个脚本只用标准库重算一遍
    结构约束，相当于给导出加一道独立的第二意见 —— 工具和校验脚本同时错的可能性，
    远低于工具自己错。

    它只查**结构**，不查语义：文本写得好不好、动作符不符合物理，脚本判断不了。
    跨模态的东西要靠 signMap，那是数据集配置，不在这里。

检查项（与 src/domain/vla/rules.ts 同构，但独立实现）：
    1. 每行是合法 JSON，且含 instructions / actions / hz
    2. 区间合法（start <= end）、不重叠、覆盖样本范围（gap 只报告不失败）
    3. 所有通道长度一致，且覆盖到样本末帧
    4. 通道值全部是有限数（不接收 null / 字符串 / NaN）
    5. 指令文本非空（去标点后 >= 2 字符）
    6. alignment 的 instruction_id 都能对上

退出码：0 = 全部通过（可以有 warning），1 = 有 error，2 = 用法错误。

为什么用 snake_case 做字段名：
    这是训练侧的格式，不是工具内部格式。工具内部 camelCase 只活在浏览器里。
"""
import json
import sys
import unicodedata

PUNCT_EXTRA = "，。；：！？、…—－·「」『』（）【】《》"


def norm_text(s):
    """与 TS 侧 normalizeText 等价：去空白与标点，英文小写"""
    out = []
    for ch in s.lower():
        if ch.isspace() or unicodedata.category(ch).startswith("P"):
            continue
        if ch in PUNCT_EXTRA:
            continue
        out.append(ch)
    return "".join(out)


def as_int(v):
    """帧号必须是整数；JSON 里 5.0 也算 —— 训练侧用 pandas 转过一遍很常见"""
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return None


class Report:
    def __init__(self):
        self.errors = []
        self.warns = []

    def err(self, line, msg):
        self.errors.append(f"第 {line} 行 error: {msg}")

    def warn(self, line, msg):
        self.warns.append(f"第 {line} 行 warn:  {msg}")


def check_record(rec, line, rep):
    if not isinstance(rec, dict):
        rep.err(line, "顶层不是对象")
        return None

    hz = rec.get("hz")
    if not isinstance(hz, (int, float)) or hz <= 0:
        rep.err(line, f"hz 无效：{hz!r}")
        hz = 10

    ins = rec.get("instructions")
    if not isinstance(ins, list) or not ins:
        rep.err(line, "没有 instructions")
        return None

    rng = rec.get("range")
    if not (isinstance(rng, list) and len(rng) == 2):
        rep.warn(line, "缺少 range，跳过覆盖检查")
        rng = None

    spans = []
    for i, s in enumerate(ins):
        if not isinstance(s, dict):
            rep.err(line, f"instructions[{i}] 不是对象")
            continue
        text = s.get("text")
        if not isinstance(text, str):
            rep.err(line, f"instructions[{i}].text 不是字符串")
            continue
        if len(norm_text(text)) < 2:
            rep.err(line, f"instructions[{i}] 文本为空或只有标点：{text!r}")
        a, b = as_int(s.get("start_frame")), as_int(s.get("end_frame"))
        if a is None or b is None:
            rep.err(line, f"instructions[{i}] 区间不是整数：{s.get('start_frame')!r}..{s.get('end_frame')!r}")
            continue
        if a > b:
            rep.err(line, f"instructions[{i}] 起止颠倒：{a}..{b}")
            continue
        spans.append((a, b, s.get("id", f"#{i}")))

    spans.sort()
    for i in range(1, len(spans)):
        if spans[i][0] <= spans[i - 1][1]:
            rep.err(line, f"指令重叠：{spans[i-1][2]} 与 {spans[i][2]} 在 {spans[i][0]}..{spans[i-1][1]}")

    if rng and spans:
        cursor = rng[0]
        for a, b, sid in spans:
            if a > cursor:
                rep.warn(line, f"第 {cursor}..{a-1} 帧无指令覆盖")
            cursor = max(cursor, b + 1)
        if cursor <= rng[1]:
            rep.warn(line, f"末尾第 {cursor}..{rng[1]} 帧无指令覆盖")

    actions = rec.get("actions")
    if not isinstance(actions, dict) or not actions:
        rep.err(line, "没有 actions")
        return {"hz": hz, "spans": spans, "channels": 0, "frames": 0}

    lengths = {}
    for name, ch in actions.items():
        # 两种写法都接受，与 TS 侧 parseVlaJsonl 一致：
        #   "steer": [...]  /  "steer": {"values": [...], "unit": "norm"}
        # 只接受对象会让第三方导出的裸数组文件整批判失败，而那是合法输入。
        if isinstance(ch, list):
            vals = ch
            start = None
        elif isinstance(ch, dict):
            vals = ch.get("values")
            start = ch.get("start_frame")
        else:
            rep.err(line, f"actions.{name} 既不是数组也不是对象")
            continue
        if not isinstance(vals, list):
            rep.err(line, f"actions.{name}.values 不是数组")
            continue
        lengths[name] = len(vals)
        bad = [i for i, v in enumerate(vals) if not isinstance(v, (int, float)) or v != v
               or v in (float("inf"), float("-inf"))]
        if bad:
            rep.err(line, f"actions.{name} 有 {len(bad)} 个非有限值，首个下标 {bad[0]}")
        if rng and as_int(start) is not None and as_int(start) + len(vals) - 1 > rng[1]:
            rep.err(line, f"actions.{name} 覆盖到 {as_int(start) + len(vals) - 1}，超出样本末帧 {rng[1]}")

    if len(set(lengths.values())) > 1:
        rep.err(line, f"通道长度不一致：{lengths}")

    al = rec.get("alignment")
    if isinstance(al, list):
        ids = {s.get("id") for s in ins if isinstance(s, dict)}
        for k, link in enumerate(al):
            if not isinstance(link, dict):
                continue
            if link.get("instruction_id") not in ids:
                rep.err(line, f"alignment[{k}] 指向不存在的指令 {link.get('instruction_id')!r}")

    return {"hz": hz, "spans": spans, "channels": len(lengths), "frames": next(iter(lengths.values()), 0)}


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("-")]
    if not args:
        print(__doc__.strip().split("\n\n")[1], file=sys.stderr)
        return 2
    path = args[0]
    quiet = "--quiet" in argv

    rep = Report()
    ok_rows = 0
    total_frames = 0
    total_channels = 0

    try:
        with open(path, "r", encoding="utf-8") as f:
            for line_no, line in enumerate(f, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError as e:
                    rep.err(line_no, f"不是合法 JSON（{e.msg}）")
                    continue
                info = check_record(rec, line_no, rep)
                if info:
                    ok_rows += 1
                    total_frames += info["frames"]
                    total_channels += info["channels"]
    except FileNotFoundError:
        print(f"找不到文件：{path}", file=sys.stderr)
        return 2

    for w in rep.warns:
        if not quiet:
            print(w)
    for e in rep.errors:
        print(e)

    print()
    print(f"样本行      {ok_rows}")
    print(f"通道总数    {total_channels}")
    print(f"帧样本合计  {total_frames}")
    print(f"warning     {len(rep.warns)}")
    print(f"error       {len(rep.errors)}")
    if rep.errors:
        print("\n结论：不通过（有结构性错误，训练侧会读到坏样本）")
        return 1
    print("\n结论：通过（结构自洽；语义与对齐质量需人工或规则引擎判断）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
