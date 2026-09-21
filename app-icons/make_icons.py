"""Example generator for flat, high-contrast Discord application icons. Drawn at 4x
and downsampled so the strokes stay crisp at Discord's ~60 px card tile.

The glyph functions at the bottom are one author's set — copy one, change the
shape and the colours, add it to `icons`. Needs Pillow (`pip install pillow`).
Run:  python make_icons.py   -> <name>.png (1024x1024) + contact.png preview
"""
import math, os
from PIL import Image, ImageDraw

S = 4096            # working size
OUT = 1024
C = S // 2
INK = (236, 233, 226)
HERE = os.path.dirname(os.path.abspath(__file__))

def canvas(bg, glow):
    """Solid tile with a soft radial lift in the centre so it doesn't read as dead flat."""
    base = Image.new("RGB", (S, S), bg)
    top = Image.new("RGB", (S, S), glow)
    mask = Image.radial_gradient("L").resize((S, S), Image.LANCZOS)          # 0 centre -> 255 edge
    mask = mask.point(lambda v: int((255 - v) * 0.45))                        # gentle, centre-weighted
    return Image.composite(top, base, mask)

def cap(d, x, y, w):
    d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=INK)

def stroke(d, pts, w):
    """Thick smooth stroke: PIL's wide polylines show segment ribbing, so lay down
    overlapping discs every few pixels of arc length instead."""
    step = max(4.0, w / 10)
    carry = 0.0
    cap(d, *pts[0], w)
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        seg = math.hypot(x1 - x0, y1 - y0)
        if seg == 0:
            continue
        t = carry
        while t <= seg:
            k = t / seg
            cap(d, x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, w)
            t += step
        carry = t - seg
    cap(d, *pts[-1], w)

def finish(img, name):
    img = img.resize((OUT, OUT), Image.LANCZOS)
    path = os.path.join(HERE, f"{name}.png")
    img.save(path)
    return img

# ---------------------------------------------------------------- glyphs

def life():
    # one clean wave across the tile
    img = canvas((14, 34, 38), (30, 70, 76)); d = ImageDraw.Draw(img)
    w = 230
    pts = []
    x0, x1, amp = 620, S - 620, 330
    for i in range(0, 401):
        t = i / 400
        x = x0 + (x1 - x0) * t
        y = C + amp * math.sin(2 * math.pi * t)
        pts.append((x, y))
    stroke(d, pts, w)
    return finish(img, "life")

def wu_wei():
    # an open circle, one stroke, gap at the upper right
    img = canvas((17, 17, 20), (44, 44, 50)); d = ImageDraw.Draw(img)
    r, w = 1180, 240
    start, end = 335, 265          # PIL arcs go clockwise from 3 o'clock; 70 degree gap at the upper right
    d.arc((C - r, C - r, C + r, C + r), start=start, end=end, fill=INK, width=w)
    for a in (start, end):
        cap(d, C + (r - w / 2) * math.cos(math.radians(a)), C + (r - w / 2) * math.sin(math.radians(a)), w)
    return finish(img, "wu_wei")

def amor_fati():
    # a spiral, drawn outward
    img = canvas((32, 16, 24), (70, 34, 48)); d = ImageDraw.Draw(img)
    w = 210
    pts = []
    turns = 2.25
    for i in range(0, 1400):
        t = i / 1399
        th = t * turns * 2 * math.pi
        r = 90 + t * 1250
        pts.append((C + r * math.cos(th), C + r * math.sin(th)))
    stroke(d, pts, w)
    return finish(img, "amor_fati")

def eternal_recurrence():
    # a ring with the return point marked
    img = canvas((15, 17, 36), (36, 40, 78)); d = ImageDraw.Draw(img)
    r, w = 1180, 230
    d.ellipse((C - r, C - r, C + r, C + r), outline=INK, width=w)
    mr = 300
    d.ellipse((C - mr, C - r - mr, C + mr, C - r + mr), fill=INK)
    return finish(img, "eternal_recurrence")

def what_is_up_to_me():
    # the dichotomy of control: a thin ring for everything, a solid core for what's yours
    img = canvas((20, 22, 27), (46, 50, 60)); d = ImageDraw.Draw(img)
    r, w = 1320, 90
    d.ellipse((C - r, C - r, C + r, C + r), outline=INK, width=w)
    cr = 540
    d.ellipse((C - cr, C - cr, C + cr, C + cr), fill=INK)
    return finish(img, "what_is_up_to_me")

icons = [life(), wu_wei(), amor_fati(), eternal_recurrence(), what_is_up_to_me()]

# contact sheet: full size row + a row at Discord's card size, on Discord's card grey
sheet = Image.new("RGB", (5 * 220 + 40, 220 + 40 + 120), (43, 45, 49))
for i, ic in enumerate(icons):
    x = 20 + i * 220
    sheet.paste(ic.resize((200, 200), Image.LANCZOS), (x, 20))
    small = ic.resize((60, 60), Image.LANCZOS)
    m = Image.new("L", (60, 60), 0); ImageDraw.Draw(m).rounded_rectangle((0, 0, 59, 59), radius=8, fill=255)
    sheet.paste(small, (x + 70, 260), m)
sheet.save(os.path.join(HERE, "contact.png"))
print("wrote", [n + ".png" for n in ("life", "wu_wei", "amor_fati", "eternal_recurrence", "what_is_up_to_me")], "+ contact.png")
