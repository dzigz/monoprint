"""Generate original synthetic font fixtures. No system font data; CC0.
Run with Python + fontTools to reproduce the small checked-in TTF/TTC files.
"""
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.ttLib import TTCollection

ROOT = Path(__file__).parent
BASIC = set(range(32, 127)) | set(map(ord, 'åäöÅÄÖüÜßéÉàÀ'))
WIDE = BASIC | set(map(ord, 'čćđšžČĆĐŠŽẞéÉñÑøØæÆœŒČĆЂђабвгдАБВГДΩωαβγ€—–…“”’\u0301\u0308\u0327'))

def make(name, chars, weight=400, italic=False, broken=False):
    fb = FontBuilder(1000, isTTF=True)
    cmap = {cp: 'g%04X' % cp for cp in sorted(chars)}
    order = ['.notdef', *cmap.values(), 'fi']
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap(cmap)
    glyphs = {}
    for glyph in order:
        pen = TTGlyphPen(None)
        if glyph not in ('.notdef', 'g0020'):
            pen.moveTo((50, 0)); pen.lineTo((450, 0)); pen.lineTo((450, 700)); pen.lineTo((50, 700)); pen.closePath()
        glyphs[glyph] = pen.glyph()
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({glyph: (0 if glyph in ('g0301', 'g0308', 'g0327') else 500, 0) for glyph in order})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    style = 'Bold' if weight == 700 else 'Regular'
    if italic: style = 'Italic'
    fb.setupNameTable({'familyName': 'Coverage Test', 'styleName': style, 'uniqueFontIdentifier': name, 'fullName': name, 'psName': name})
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200, usWeightClass=weight, fsType=8)
    fb.setupPost(italicAngle=-12 if italic else 0)
    fb.setupMaxp()
    features = 'feature liga { sub g0066 g0069 by fi; } liga;'
    if broken: features += ' feature calt { sub g0058 by .notdef; } calt;'
    addOpenTypeFeaturesFromString(fb.font, features)
    fb.font['head'].created = fb.font['head'].modified = 3786912000
    fb.save(ROOT / (name + '.ttf'))
    return fb.font

wide = make('Wide-Regular', WIDE)
narrow = make('Narrow-Bold', BASIC, 700)
make('Narrow-Italic', BASIC, italic=True)
make('Broken-Shaping', WIDE, broken=True)
collection = TTCollection(); collection.fonts = [wide, narrow]; collection.save(ROOT / 'Two-Faces.ttc')
