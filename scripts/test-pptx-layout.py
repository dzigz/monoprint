"""Offline export checks using a small generated font, without deck fixtures."""
import copy,importlib.util,io,math,struct,tempfile,unittest
from pathlib import Path
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
spec=importlib.util.spec_from_file_location('layout',Path(__file__).with_name('pptx-layout.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class LayoutExport(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
  glyphs={}
  for name in ['.notdef','space','A','B']:
   pen=TTGlyphPen(None)
   if name!='space':pen.moveTo((0,0));pen.lineTo((250,700));pen.lineTo((500,0));pen.closePath()
   glyphs[name]=pen.glyph()
  b=FontBuilder(1000,isTTF=True);b.setupGlyphOrder(list(glyphs));b.setupCharacterMap({32:'space',65:'A',66:'B'});b.setupGlyf(glyphs)
  b.setupHorizontalMetrics({g:(250 if g=='space' else 600,0) for g in glyphs});b.setupHorizontalHeader(ascent=800,descent=-200)
  b.setupNameTable({'familyName':'Fixture','styleName':'Regular','uniqueFontIdentifier':'Fixture','fullName':'Fixture Regular','psName':'Fixture-Regular'})
  b.setupOS2(sTypoAscender=800,sTypoDescender=-200,usWinAscent=800,usWinDescent=200,fsType=8);b.setupPost();b.setupMaxp();b.save(self.root/'fixture.ttf')
  self.files={'f':{'path':str(self.root/'fixture.ttf')}}
 def word(self,text,y,line):return dict(text=text,fontId='f',em=20,scaleX=1,angle=0,color='#123456',baseline=[0,y],line=line)
 def payload(self):
  obj={'id':'object','frame':{'x':100,'y':100,'width':200,'height':100},'resolved':{'words':[self.word('AB',20,'a'),self.word('BA',46,'b')]},'text':'AB\nBA','style':{'fontId':'f','fontSize':20,'lineHeight':1.3,'align':'left','color':'#123456'}}
  return {'fontFiles':self.files,'backgrounds':{'s':'background.png'},'deck':{'fonts':[{'id':'f','metrics':{'ascent':800,'descent':-200,'unitsPerEm':1000}}],'slides':[{'id':'s','canvas':{'width':800,'height':450},'layers':{'objects':[obj]}}]}}
 def test_embeds_full_editable_face_in_eot_v2_and_does_not_mutate_source(self):
  source=(self.root/'fixture.ttf').read_bytes();self.root.joinpath('fonts').mkdir();fonts=m.Fonts(self.files,self.root/'fonts');f=fonts.get('f');wrapped=m.eot_font(f['path'])
  total,size,version=struct.unpack('<III',wrapped[:12]);self.assertEqual(total,len(wrapped));self.assertEqual(version,0x20001)
  embedded=TTFont(io.BytesIO(wrapped[-size:]));self.assertEqual(embedded.getBestCmap(),TTFont(io.BytesIO(source)).getBestCmap());self.assertEqual(embedded['OS/2'].fsType,8)
  self.assertEqual((self.root/'fixture.ttf').read_bytes(),source);self.assertNotEqual(embedded['name'].getDebugName(1),'Fixture')
 def test_multiline_box_preserves_baselines_and_source(self):
  payload=self.payload();original=copy.deepcopy(payload);plan=m.prepare(payload,self.root/'fonts');self.assertEqual(payload,original)
  shape=plan['slides'][0]['shapes'][0];self.assertEqual(plan['stats']['multilineBoxes'],1);self.assertEqual(len(plan['slides'][0]['shapes']),1)
  target=m.ET.Element(m.tag('p:sp'));m.add(target,'p:txBody');m.write_text(target,shape)
  self.assertEqual([e.text for e in target.findall('.//a:t',m.NS)],['AB','BA']);self.assertEqual(target.find('.//a:lnSpc/a:spcPts',m.NS).get('val'),str(m.pt(26)))
 def test_rotation_preserves_the_original_baseline_anchor(self):
  p=self.payload();words=p['deck']['slides'][0]['layers']['objects'][0]['resolved']['words'];words[:]=words[:1];words[0]['angle']=17
  shape=m.prepare(p,self.root/'fonts')['slides'][0]['shapes'][0];cx=shape['width']/2;cy=shape['height']/2;a=math.radians(17)
  x=shape['left']+cx-cx*math.cos(a)-(20-cy)*math.sin(a);y=shape['top']+cy-cx*math.sin(a)+(20-cy)*math.cos(a)
  self.assertAlmostEqual(x,100);self.assertAlmostEqual(y,120)
 def test_edited_text_retains_blank_lines_and_spacing(self):
  p=self.payload();o=p['deck']['slides'][0]['layers']['objects'][0];del o['resolved'];o['text']='AB\n\nBA';o['style']['letterSpacing']=1
  plan=m.prepare(p,self.root/'fonts');rows=plan['slides'][0]['shapes'][0]['lines'];self.assertEqual(rows[1][0]['y']-rows[0][0]['y'],52);self.assertEqual(rows[0][0]['advance'],26)
 def test_restricted_embedding_stops_instead_of_substituting(self):
  f=TTFont(self.root/'fixture.ttf');f['OS/2'].fsType=2;f.save(self.root/'fixture.ttf')
  with self.assertRaisesRegex(ValueError,'editable embedding'):m.prepare(self.payload(),self.root/'fonts')

if __name__=='__main__':unittest.main()
