# Renders the PNG fallbacks of the heart icon: off-white heart on the site's dark background.
import sys
from PIL import Image, ImageDraw
out = sys.argv[1]
segs = [((12,21.2),(12,21.2),(2.6,14.9),(2.6,8.6)),((2.6,8.6),(2.6,5.5),(5,3.2),(7.9,3.2)),((7.9,3.2),(9.6,3.2),(11.1,4.1),(12,5.5)),((12,5.5),(12.9,4.1),(14.4,3.2),(16.1,3.2)),((16.1,3.2),(19,3.2),(21.4,5.5),(21.4,8.6)),((21.4,8.6),(21.4,14.9),(12,21.2),(12,21.2))]
pts = []
for p0,p1,p2,p3 in segs:
    for i in range(64):
        t=i/64; u=1-t
        pts.append((u**3*p0[0]+3*u*u*t*p1[0]+3*u*t*t*p2[0]+t**3*p3[0], u**3*p0[1]+3*u*u*t*p1[1]+3*u*t*t*p2[1]+t**3*p3[1]))
def render(size, fill_frac, radius_frac, name):
    ss = 8; n = size*ss
    img = Image.new('RGBA', (n, n), (0,0,0,0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0,0,n-1,n-1], radius=int(n*radius_frac), fill=(10,10,10,255))
    k = n*fill_frac/18.8; ox = n/2 - 12*k; oy = n/2 - 12.2*k
    d.polygon([(ox+x*k, oy+y*k) for x,y in pts], fill=(237,237,237,255))
    img.resize((size,size), Image.LANCZOS).save(f'{out}/{name}', optimize=True)
render(180, 0.56, 0, 'apple-touch-icon.png')   # iOS rounds the corners itself
render(32, 0.70, 0.22, 'favicon-32.png')       # for browsers without SVG icon support
