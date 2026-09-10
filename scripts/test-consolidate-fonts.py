import copy
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

PIPELINE = Path(sys.argv[1])
sys.path.insert(0,str(PIPELINE/'scripts/matching'))
import rerender_cal as rc
import font_consolidation as fc
from resolved_layout import word_metrics
spec = importlib.util.spec_from_file_location('adapter',Path(__file__).with_name('consolidate-fonts.py'))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class SavedGeometryConsolidation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        regular={'path':'/System/Library/Fonts/Supplemental/Arial.ttf','face_index':0}
        narrow=rc.build_instance(regular,.9,Path(cls.temp.name)/'narrow.ttf')
        bold={'path':'/System/Library/Fonts/Supplemental/Arial Bold.ttf','face_index':0}
        cls.fonts={'regular':regular,'narrow':narrow,'bold':bold}

    @classmethod
    def tearDownClass(cls): cls.temp.cleanup()

    def object(self,scale=1,angle=0):
        runs=[]
        for i,(text,font) in enumerate([('A considerably longer sentence','regular'),('Short line','narrow')]):
            u,v=fc.world(20,50+i*50,angle)
            runs.append(dict(id=i,text=text,fontId=font,em=24,baseline=[u*scale,v],angle=angle,color='#123456',line=str(i),scaleX=scale))
        return dict(id='box',kind='text',text='\n'.join(w['text'] for w in runs),
                    frame=dict(x=100,y=100,width=500,height=150),style=dict(fontId='regular',align='left',fontSize=24,color='#123456'),
                    origin={'kind':'recovered'},resolved=dict(revision='original',words=runs))

    def test_preserves_text_color_scale_angle_and_vertical_baselines(self):
        for scale,angle in [(1,0),(1.4,7)]:
            original=self.object(scale,angle); snapshot=copy.deepcopy(original)
            after,status,_=adapter.transform(original,dict(width=1800,height=900),self.fonts)
            self.assertEqual(status,'consolidated');self.assertEqual(original,snapshot)
            self.assertEqual(after['text'],original['text'])
            self.assertEqual(len({w['fontId'] for w in after['resolved']['words']}),1)
            self.assertEqual(after['origin'],original['origin'])
            for a,b in zip(original['resolved']['words'],after['resolved']['words']):
                for field in ('id','text','em','angle','color','line','scaleX'): self.assertEqual(a[field],b[field])
                before=fc.project([(original['frame']['x']+a['baseline'][0])/scale,original['frame']['y']+a['baseline'][1]],angle)
                result=fc.project([(after['frame']['x']+b['baseline'][0])/scale,after['frame']['y']+b['baseline'][1]],angle)
                self.assertAlmostEqual(before[1],result[1])
            self.assertEqual(adapter.transform(after,dict(width=1800,height=900),self.fonts)[1],'alreadyUniform')

    def test_edited_locked_or_missing_geometry_is_untouched(self):
        for change in ({'text':'User edited text'},{'resolved':None},{'locked':True}):
            obj={**self.object(),**change}
            self.assertEqual(adapter.transform(obj,dict(width=1800,height=900),self.fonts)[:2],(None,'skipped'))

    def test_mixed_fonts_on_a_line_and_mixed_weight_remain_untouched(self):
        mixed=self.object(); mixed['resolved']['words'][1]['line']='0';mixed['text']=mixed['text'].replace('\n',' ')
        bold=self.object();bold['resolved']['words'][1]['fontId']='bold'
        for obj in (mixed,bold):
            self.assertEqual(adapter.transform(obj,dict(width=1800,height=900),self.fonts)[:2],(None,'preserved'))

    def test_network_and_subprocess_calls_are_blocked(self):
        import socket
        import subprocess
        with self.assertRaisesRegex(RuntimeError,'offline only'): socket.getaddrinfo('example.com',443)
        with self.assertRaisesRegex(RuntimeError,'offline only'): subprocess.run(['false'])


if __name__=='__main__': unittest.main(argv=[sys.argv[0]])
