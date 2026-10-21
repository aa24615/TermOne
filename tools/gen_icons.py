#!/usr/bin/env python3
"""生成 TermOne 应用图标（PNG / ICO / ICNS），仅依赖 Python 标准库。

- Windows / Linux (PNG、ICO)：满幅设计
- macOS (ICNS)：按 Apple 规范留白，内容约占画布 80%，圆角比例 0.2245

用法: python3 tools/gen_icons.py
输出目录: apps/desktop/src-tauri/icons/
"""
import math
import os
import struct
import zlib

BASE = 512
OUT = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 "..", "apps", "desktop", "src-tauri", "icons"))

BG_TOP = (139, 99, 255)     # #8B63FF
BG_BOTTOM = (63, 35, 205)   # #3F23CD
FG = (245, 246, 255)        # #F5F6FF

FULL_BLEED_RADIUS = 112 / 512        # Windows/Linux 满幅圆角比例
MAC_CONTENT_RATIO = 0.8              # macOS 内容占画布比例（Apple 规范约 80%）
MAC_RADIUS = 0.2245                  # macOS 圆角 / 内容尺寸（Big Sur 模板 185/824）

# “❯1” 标识：提示符箭头 + 数字 1（TermOne），512 基准坐标
GLYPH_LW = 36
CHEVRON = (110, 150, 230, 256, 110, 362)          # ❯
ONE_STEM = (392, 148, 392, 364)                   # “1” 竖笔
ONE_FLAG = (318, 212, 394, 144)                   # “1” 旗笔


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def rr_sdf(x, y, size, r):
    """点到 [0,size]^2 圆角矩形的带符号距离（内部为负）。"""
    hx = size / 2.0
    hy = size / 2.0
    qx = abs(x - hx) - (hx - r)
    qy = abs(y - hy) - (hy - r)
    ax = max(qx, 0.0)
    ay = max(qy, 0.0)
    return math.hypot(ax, ay) + min(max(qx, qy), 0.0) - r


def seg_d(x, y, x1, y1, x2, y2):
    """点到线段的距离。"""
    vx = x2 - x1
    vy = y2 - y1
    wx = x - x1
    wy = y - y1
    denom = vx * vx + vy * vy
    t = 0.0 if denom == 0 else clamp((wx * vx + wy * vy) / denom, 0.0, 1.0)
    return math.hypot(wx - t * vx, wy - t * vy)


def render(size, content_ratio=1.0, radius_ratio=FULL_BLEED_RADIUS):
    """绘制图标：圆角方块 + 渐变 + “>_” 符号，SDF 抗锯齿。

    content_ratio < 1 时内容居中缩小（macOS 留白规范）。
    """
    content = size * content_ratio
    off = (size - content) / 2.0
    s = content / BASE          # 512 基准设计坐标 → 画布坐标
    r = content * radius_ratio
    lw = GLYPH_LW * s
    cx1, cy1, cx2, cy2, cx3, cy3 = (v * s for v in CHEVRON)
    sx1, sy1, sx2, sy2 = (v * s for v in ONE_STEM)
    fx1, fy1, fx2, fy2 = (v * s for v in ONE_FLAG)
    img = []
    for y in range(size):
        py = y + 0.5
        ly = py - off
        g = clamp(ly / content, 0.0, 1.0)
        bg = tuple(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * g for i in range(3))
        row = []
        for x in range(size):
            px = x + 0.5
            lx = px - off
            a = clamp(0.5 - rr_sdf(lx, ly, content, r), 0.0, 1.0)
            if a <= 0.0:
                row.append((0, 0, 0, 0))
                continue
            # 对角高光带，增加立体感
            band = clamp(1.0 - abs((lx - ly) - 0.16 * content) / (0.42 * content), 0.0, 1.0)
            hi_a = 0.10 * band * band
            col = tuple(bg[i] + (255 - bg[i]) * hi_a for i in range(3))
            dg = min(
                seg_d(lx, ly, cx1, cy1, cx2, cy2),
                seg_d(lx, ly, cx2, cy2, cx3, cy3),
                seg_d(lx, ly, sx1, sy1, sx2, sy2),
                seg_d(lx, ly, fx1, fy1, fx2, fy2),
            ) - lw / 2.0
            fg_a = clamp(0.5 - dg, 0.0, 1.0)
            col = tuple(col[i] + (FG[i] - col[i]) * fg_a for i in range(3))
            row.append((int(col[0]), int(col[1]), int(col[2]), int(a * 255)))
        img.append(row)
    return img


def downscale(img, from_size, to_size):
    f = from_size // to_size
    out = []
    for y in range(to_size):
        row = []
        for x in range(to_size):
            sr = sg = sb = sa = 0
            for dy in range(f):
                src = img[y * f + dy]
                for dx in range(f):
                    c = src[x * f + dx]
                    sr += c[0]
                    sg += c[1]
                    sb += c[2]
                    sa += c[3]
            n = f * f
            row.append((sr // n, sg // n, sb // n, sa // n))
        out.append(row)
    return out


def png_bytes(img):
    h = len(img)
    w = len(img[0])
    raw = b"".join(b"\x00" + bytes(v for px in row for v in px) for row in img)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def write_ico(path, entries):
    count = len(entries)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    directory = b""
    blobs = b""
    for size, data in entries:
        w = 0 if size >= 256 else size
        directory += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        blobs += data
    with open(path, "wb") as f:
        f.write(header + directory + blobs)


def write_icns(path, entries):
    total = 8
    for _, d in entries:
        total += 8 + len(d)
    out = b"icns" + struct.pack(">I", total)
    for t, d in entries:
        out += t.encode("ascii") + struct.pack(">I", 8 + len(d)) + d
    with open(path, "wb") as f:
        f.write(out)


def main():
    os.makedirs(OUT, exist_ok=True)
    print("rendering %dpx icon (full bleed for win/linux) ..." % BASE)
    base = render(BASE)
    sizes = {
        512: base,
        256: downscale(base, 512, 256),
    }
    sizes[128] = downscale(sizes[256], 256, 128)
    sizes[32] = downscale(sizes[128], 128, 32)

    names = {32: "32x32.png", 128: "128x128.png", 256: "128x128@2x.png", 512: "icon.png"}
    for sz, img in sizes.items():
        p = os.path.join(OUT, names[sz])
        with open(p, "wb") as f:
            f.write(png_bytes(img))
        print("wrote", p)

    ico_path = os.path.join(OUT, "icon.ico")
    write_ico(ico_path, [
        (32, png_bytes(sizes[32])),
        (128, png_bytes(sizes[128])),
        (256, png_bytes(sizes[256])),
    ])
    print("wrote", ico_path)

    print("rendering macOS icons (content %.0f%%, Apple guidelines) ..."
          % (MAC_CONTENT_RATIO * 100))
    icns_entries = []
    for tag, sz in (("ic07", 128), ("ic08", 256), ("ic09", 512)):
        img = render(sz, MAC_CONTENT_RATIO, MAC_RADIUS)
        icns_entries.append((tag, png_bytes(img)))
    icns_path = os.path.join(OUT, "icon.icns")
    write_icns(icns_path, icns_entries)
    print("wrote", icns_path)


if __name__ == "__main__":
    main()
