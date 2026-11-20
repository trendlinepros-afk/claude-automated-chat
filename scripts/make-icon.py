# Generates build/icon.png (512x512). Run: python3 scripts/make-icon.py
from PIL import Image, ImageDraw
S = 512
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
grad = Image.new('RGBA', (S, S))
px = grad.load()
for y in range(S):
    for x in range(S):
        t = (x + y) / (2 * S)
        px[x, y] = (int(124 + (91 - 124) * t), int(108 + (140 - 108) * t), 255, 255)
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([16, 16, S - 16, S - 16], radius=110, fill=255)
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)
# two chat bubbles
d.rounded_rectangle([90, 120, 330, 290], radius=50, fill=(255, 255, 255, 240))
d.polygon([(130, 280), (120, 345), (190, 285)], fill=(255, 255, 255, 240))
d.rounded_rectangle([190, 250, 425, 410], radius=50, fill=(24, 20, 60, 230))
d.polygon([(380, 400), (395, 455), (330, 405)], fill=(24, 20, 60, 230))
# arrows
for i, cx in enumerate([160, 210, 260]):
    d.ellipse([cx - 14, 191, cx + 14, 219], fill=(124, 108, 255, 255))
d.line([250, 330, 360, 330], fill=(255, 255, 255, 255), width=18)
d.polygon([(355, 305), (395, 330), (355, 355)], fill=(255, 255, 255, 255))
img.save('build/icon.png')
print('ok')
