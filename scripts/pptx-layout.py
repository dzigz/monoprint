"""Prepare editable PowerPoint geometry and embed uniquely named, full fonts.

Runs in the same local Python environment as font consolidation. No network.
"""
import argparse
import copy
import hashlib
import io
import json
import math
import os
import re
import struct
import zipfile
from collections import OrderedDict
from pathlib import Path
from xml.etree import ElementTree as ET

import uharfbuzz as hb
from fontTools.ttLib import TTFont

NS = {'a':'http://schemas.openxmlformats.org/drawingml/2006/main',
      'p':'http://schemas.openxmlformats.org/presentationml/2006/main',
      'r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
for prefix,uri in NS.items(): ET.register_namespace(prefix,uri)
def tag(name):
    prefix,local=name.split(':');return '{'+NS[prefix]+'}'+local
def add(parent,name,attrs=None): return ET.SubElement(parent,tag(name),{k:str(v) for k,v in (attrs or {}).items()})
def xml(node): return ET.tostring(node,encoding='utf-8',xml_declaration=True)
def pt(px): return round(px*75)
def emu(px): return round(px*9525)

class Fonts:
    def __init__(self, files, directory):
        self.files=files;self.directory=directory;self.cache={};self.faces={}

    def get(self, identifier, scale=1):
        key=identifier+'|'+str(scale)
        if key in self.cache:return self.cache[key]
        spec=self.files.get(identifier)
        if not spec:raise ValueError('Missing font file: '+identifier)
        raw=Path(spec['path']).read_bytes()
        digest=hashlib.sha256(raw+str(spec.get('face_index',0)).encode()+str(scale).encode()+b'export-metrics-v4').hexdigest()[:20]
        family='MP'+digest
        cache_file=self.directory/(family+'.json')
        if cache_file.exists():
            try:
                result=json.loads(cache_file.read_text());data=Path(result['path']).read_bytes()
                face=hb.Face(data);hf=hb.Font(face);hf.scale=(face.upem,face.upem);hb.ot_font_set_funcs(hf)
                self.faces[family]=hf;self.cache[key]={**result,'sourceId':identifier};return self.cache[key]
            except (OSError,ValueError,KeyError):pass
        font=TTFont(io.BytesIO(raw),fontNumber=spec.get('face_index',0))
        permissions=font['OS/2'].fsType
        if permissions & 512 or (permissions & (2|4) and not permissions & 8):
            raise ValueError('Font does not permit editable embedding: '+identifier)
        if 'fvar' in font:
            from fontTools.varLib.instancer import instantiateVariableFont
            font=instantiateVariableFont(font,{a.axisTag:a.defaultValue for a in font['fvar'].axes},inplace=True)
        if abs(scale-1)>1e-8:self.scale_x(font,scale)
        if 'CFF ' in font:
            # PowerPoint's embedded font support requires TrueType outlines.
            # Sub-font-unit conversion error stays far below a rendered pixel.
            from fontTools.fontBuilder import FontBuilder
            from fontTools.pens.cu2quPen import Cu2QuPen
            from fontTools.pens.ttGlyphPen import TTGlyphPen
            glyphset=font.getGlyphSet();glyphs={}
            for name in font.getGlyphOrder():
                pen=TTGlyphPen(glyphset)
                glyphset[name].draw(Cu2QuPen(pen,max_err=0.25,reverse_direction=True))
                glyphs[name]=pen.glyph()
            del font['CFF ']
            font.sfntVersion='\x00\x01\x00\x00'
            builder=FontBuilder(font=font);builder.isTTF=True
            builder.setupGlyf(glyphs);builder.setupMaxp();builder.setupPost()
        if 'DSIG' in font:del font['DSIG']
        # A consistent line metric envelope makes paragraph placement portable;
        # glyph outlines, advances, weight and explicit recovered baselines stay
        # unchanged. It also removes differing hhea/OS2 metric choices in Office.
        upem=font['head'].unitsPerEm;ascent=upem;descent=round(upem*.2)
        font['hhea'].ascent=ascent;font['hhea'].descent=-descent;font['hhea'].lineGap=0
        font['OS/2'].sTypoAscender=ascent;font['OS/2'].sTypoDescender=-descent;font['OS/2'].sTypoLineGap=0
        font['OS/2'].version=max(4,font['OS/2'].version)
        font['OS/2'].usWinAscent=ascent;font['OS/2'].usWinDescent=descent;font['OS/2'].fsSelection|=128
        # Each fitted file is its own family. Retain original weight/style in
        # the exported face and in the corresponding PowerPoint run.
        bold=font['OS/2'].usWeightClass>=600
        italic=bool(font['head'].macStyle&2)
        style=('Bold Italic' if bold else 'Italic') if italic else ('Bold' if bold else 'Regular')
        for record in list(font['name'].names):
            if record.nameID in (1,2,3,4,6,16,17,18,21,22):font['name'].names.remove(record)
        for nid,value in {1:family,2:style,3:family,4:family+' '+style,6:family+'-'+style.replace(' ',''),16:family,17:style}.items():
            font['name'].setName(value,nid,3,1,0x409)
            font['name'].setName(value,nid,1,0,0)
        if 'CFF ' in font:
            cff=font['CFF '].cff;cff.fontNames=[family+'-'+style.replace(' ','')]
            top=cff.topDictIndex[0];top.FamilyName=family;top.FullName=family+' '+style
        font.recalcTimestamp=False
        file=self.directory/(family+'.otf' if 'CFF ' in font else family+'.ttf')
        temporary=file.with_suffix('.'+str(os.getpid())+'.tmp');font.save(temporary);temporary.replace(file)
        data=file.read_bytes();face=hb.Face(data);hf=hb.Font(face);hf.scale=(face.upem,face.upem);hb.ot_font_set_funcs(hf)
        self.faces[family]=hf
        result={'family':family,'path':str(file),'upem':font['head'].unitsPerEm,
                'ascent':font['hhea'].ascent,'descent':font['hhea'].descent,'lineGap':font['hhea'].lineGap,
                'bold':bold,'italic':italic,'sourceId':identifier,'scaleX':scale,
                'spaceUnits':font['hmtx'][font.getBestCmap().get(32,'.notdef')][0]}
        self.cache[key]=result
        temporary=cache_file.with_suffix('.'+str(os.getpid())+'.tmp');temporary.write_text(json.dumps(result));temporary.replace(cache_file)
        return result

    def width(self, font, text, em, kern=True):
        if not text:return 0
        b=hb.Buffer();b.add_str(text);b.guess_segment_properties()
        # Office's embedded-font path omits optional OpenType substitutions.
        features={'kern':True} if kern else {'kern':False,'liga':False,'clig':False,'calt':False}
        hb.shape(self.faces[font['family']],b,features)
        return sum(p.x_advance for p in b.glyph_positions)/font['upem']*em

    @staticmethod
    def scale_x(font,scale):
        from fontTools.pens.transformPen import TransformPen
        from fontTools.pens.ttGlyphPen import TTGlyphPen
        from fontTools.pens.t2CharStringPen import T2CharStringPen
        glyphset=font.getGlyphSet(); changed={}
        for name in font.getGlyphOrder():
            if 'glyf' in font:
                pen=TTGlyphPen(glyphset);glyphset[name].draw(TransformPen(pen,(scale,0,0,1,0,0)));changed[name]=pen.glyph()
            else:
                pen=T2CharStringPen(font['hmtx'][name][0]*scale,glyphset);glyphset[name].draw(TransformPen(pen,(scale,0,0,1,0,0)))
                top=font['CFF '].cff.topDictIndex[0]
                changed[name]=pen.getCharString(private=top.Private,globalSubrs=top.GlobalSubrs)
        for name,glyph in changed.items():
            if 'glyf' in font:font['glyf'][name]=glyph
            else:font['CFF '].cff.topDictIndex[0].CharStrings[name]=glyph
            advance,bearing=font['hmtx'][name];font['hmtx'][name]=(round(advance*scale),round(bearing*scale))
        font['hhea'].advanceWidthMax=max(a for a,b in font['hmtx'].metrics.values())
        # Keep horizontal positioning consistent with the transformed outlines.
        def scale_positions(value,seen):
            if id(value) in seen:return
            seen.add(id(value))
            if isinstance(value,(list,tuple)):
                for child in value:scale_positions(child,seen)
            elif hasattr(value,'__dict__'):
                for name,child in vars(value).items():
                    if name in ('XAdvance','XPlacement','XCoordinate') and isinstance(child,(int,float)):
                        setattr(value,name,round(child*scale))
                    else:scale_positions(child,seen)
        if 'GPOS' in font:scale_positions(font['GPOS'].table,set())
        if 'kern' in font:
            for table in font['kern'].kernTables:
                if hasattr(table,'kernTable'):table.kernTable={pair:round(value*scale) for pair,value in table.kernTable.items()}

def prepare(payload, directory):
    directory.mkdir(parents=True,exist_ok=True)
    fonts=Fonts(payload['fontFiles'],directory)
    deck=payload['deck'];slides=[];stats={'textBoxes':0,'multilineBoxes':0,'positionedWords':0}
    for slide in deck['slides']:
        shapes=[]
        for obj in slide['layers']['objects']:
            words=copy.deepcopy(obj.get('resolved',{}).get('words',[]))
            if not words:
                # Ordinary edited text uses explicit, measured line breaks.
                style=obj['style'];fid=style.get('fontId') or deck['designSystem']['typography'][style['fontRole']]['fontId']
                font=fonts.get(fid);em=style['fontSize'];lh=em*style['lineHeight']
                source=next(f for f in deck['fonts'] if f['id']==fid)
                metrics=source.get('metrics') or {};units=metrics.get('unitsPerEm',1000)
                ascent=metrics.get('ascent',units*.8)/units*em;descent=abs(metrics.get('descent',units*.2))/units*em
                tracking=style.get('letterSpacing',0);word_spacing=style.get('wordSpacing',0)
                def measure(text):return fonts.width(font,text,em)+len(text)*tracking+text.count(' ')*word_spacing
                y=(lh-ascent-descent)/2+ascent;text=obj['text'].upper() if style.get('transform')=='uppercase' else obj['text']
                for para in text.split('\n'):
                    lines=['']
                    for word in para.split(' '):
                        candidate=(lines[-1]+' '+word) if lines[-1] else word
                        if lines[-1] and measure(candidate)>obj['frame']['width']:lines.append(word)
                        else:lines[-1]=candidate
                    for line in lines:
                        width=measure(line);x=0
                        if style['align']=='center':x=(obj['frame']['width']-width)/2
                        elif style['align']=='right':x=obj['frame']['width']-width
                        line_id=str(len(words))
                        for part in re.findall(r'\S+|\s+',line):
                            if not part.isspace():
                                words.append({'text':part,'fontId':fid,'em':em,'baseline':[x,y],'angle':0,'scaleX':1,'color':style['color'],'line':line_id,
                                    'letterSpacing':tracking,'bold':bool(style.get('bold')) or font['bold'],'italic':bool(style.get('italic')) or font['italic']})
                            x+=measure(part)
                        y+=lh
            if not words:continue
            for w in words:
                if abs(w['scaleX']-1)>1e-8 and abs(w['angle'])>1e-8:
                    raise ValueError('Combined horizontal scaling and rotation require a shear transform that native PowerPoint text cannot represent.')
                w['font']=fonts.get(w['fontId'],w['scaleX']);w['x']=obj['frame']['x']+w['baseline'][0];w['y']=obj['frame']['y']+w['baseline'][1]
                w['advance']=fonts.width(w['font'],w['text'],w['em'])+len(w['text'])*w.get('letterSpacing',0)
                nominal=fonts.width(w['font'],w['text'],w['em'],False)
                w['tracking']=(w['advance']-nominal)/max(1,len(w['text']))
                w['spaceAdvance']=w['font']['spaceUnits']/w['font']['upem']*w['em']
            uniform=len({(w['font']['family'],w['em'],w['angle']) for w in words})==1 and abs(words[0]['angle'])<1e-8
            rows=OrderedDict()
            for w in words:rows.setdefault(w['line'],[]).append(w)
            # A common font/size can stay a single editable paragraph box.
            if uniform:
                groups=[list(rows.values())]
            else:
                groups=[[[w]] for w in words];stats['positionedWords']+=len(words)
            for index,lines in enumerate(groups):
                first=lines[0][0];font=first['font'];em=first['em'];ascent=font['ascent']/font['upem']*em
                x=min(w['x'] for row in lines for w in row);top=first['y']-ascent
                width=max(w['x']+w['advance'] for row in lines for w in row)-x
                bottom=max(w['y']+abs(font['descent'])/font['upem']*em for row in lines for w in row)
                shape={'name':obj['id']+('' if len(groups)==1 else '-word-'+str(index)),
                       'left':x,'top':top,'width':max(1,width+2),'height':max(em,bottom-top+2),
                       'font':font,'em':em,'angle':first['angle'],'lines':lines,'textLeft':x}
                if first['angle']:
                    # The editor rotates around the baseline; DrawingML rotates
                    # around the shape centre. Preserve the same baseline anchor.
                    radians=math.radians(first['angle']);c=math.cos(radians);s=math.sin(radians)
                    cx=shape['width']/2;cy=shape['height']/2
                    shape['left']=first['x']-cx-(-cx*c-(ascent-cy)*s)
                    shape['top']=first['y']-cy-(-cx*s+(ascent-cy)*c)
                shapes.append(shape);stats['textBoxes']+=1;stats['multilineBoxes']+=len(lines)>1
        slides.append({'id':slide['id'],'canvas':slide['canvas'],'background':payload['backgrounds'][slide['id']],
                       'notes':slide.get('talkingPoints',''),'shapes':shapes})
    return {'slides':slides,'fonts':list({f['family']:f for f in fonts.cache.values()}.values()),'stats':stats}

def run_properties(parent,w,spacing=0,baseline=0):
    f=w['font'];p=add(parent,'a:rPr',{'lang':'en-US','sz':pt(w['em']),'b':int(w.get('bold',f['bold'])),'i':int(w.get('italic',f['italic'])),
        'kern':'400000','baseline':round(baseline),'dirty':'0'})
    if spacing:p.set('spc',str(pt(spacing)))
    fill=add(p,'a:solidFill');add(fill,'a:srgbClr',{'val':w['color'].lstrip('#')[:6]})
    for name in ['a:latin','a:ea','a:cs']:add(p,name,{'typeface':f['family']})
    return p

def write_text(shape,plan):
    body=shape.find('p:txBody',NS);body.clear()
    bp=add(body,'a:bodyPr',{'wrap':'none','lIns':0,'tIns':0,'rIns':0,'bIns':0,'anchor':'t','anchorCtr':0,'rtlCol':0})
    add(bp,'a:noAutofit');add(body,'a:lstStyle')
    for index,row in enumerate(plan['lines']):
        p=add(body,'a:p');ref=row[0];pp=add(p,'a:pPr',{'marL':emu(ref['x']-plan.get('textLeft',plan['left'])),'indent':0,'algn':'l','fontAlgn':'base'})
        if index:
            delta=ref['y']-plan['lines'][index-1][0]['y']
            add(add(pp,'a:lnSpc'),'a:spcPts',{'val':pt(delta)})
        add(add(pp,'a:spcBef'),'a:spcPts',{'val':0});add(add(pp,'a:spcAft'),'a:spcPts',{'val':0});add(pp,'a:buNone')
        for wi,w in enumerate(row):
            run=add(p,'a:r');run_properties(run,w,spacing=w.get('tracking',0),baseline=(ref['y']-w['y'])/w['em']*100000)
            add(run,'a:t').text=w['text']
            if wi+1<len(row):
                gap=row[wi+1]['x']-w['x']-w['advance'];space=add(p,'a:r')
                # Space glyph advance plus character spacing carries the exact
                # recovered gap without inserting tabs or splitting the box.
                run_properties(space,w,spacing=gap-w['spaceAdvance'])
                add(space,'a:t').text=' '
        end=run_properties(p,ref);end.tag=tag('a:endParaRPr')
        default=copy.deepcopy(end);default.tag=tag('a:defRPr');pp.append(default)

def eot_font(file):
    """Uncompressed Embedded OpenType v2 container (Microsoft EOT spec)."""
    raw=Path(file).read_bytes();font=TTFont(io.BytesIO(raw));os2=font['OS/2']
    panose=bytes(getattr(os2.panose,n) for n in ('bFamilyType','bSerifStyle','bWeight','bProportion','bContrast','bStrokeVariation','bArmStyle','bLetterForm','bMidline','bXHeight'))
    header=struct.pack('<IIII',0,len(raw),0x00020001,0)+panose+struct.pack('<BBIHH',0,int(bool(os2.fsSelection&1)),os2.usWeightClass,os2.fsType,0x504c)
    header+=struct.pack('<11I',*[getattr(os2,'ulUnicodeRange'+str(i),0) for i in range(1,5)],
                        *[getattr(os2,'ulCodePageRange'+str(i),0) for i in range(1,3)],font['head'].checkSumAdjustment,0,0,0,0)
    for nid in (1,2,5,4):
        name=font['name'].getDebugName(nid) or '';encoded=name.encode('utf-16-le')
        header+=struct.pack('<HH',0,len(encoded))+encoded
    header+=struct.pack('<HH',0,0)
    return struct.pack('<I',len(header)+len(raw))+header[4:]+raw

def finish(plan,candidate,output):
    with zipfile.ZipFile(candidate) as z:parts={n:z.read(n) for n in z.namelist()}
    for si,slide in enumerate(plan['slides'],1):
        file=f'ppt/slides/slide{si}.xml';root=ET.fromstring(parts[file]);byname={s.find('p:nvSpPr/p:cNvPr',NS).get('name'):s for s in root.findall('.//p:sp',NS)}
        for shape in slide['shapes']:
            target=byname[shape['name']];write_text(target,shape)
        parts[file]=xml(root)
    presentation=ET.fromstring(parts['ppt/presentation.xml']);presentation.set('embedTrueTypeFonts','1');presentation.set('saveSubsetFonts','0')
    embed=ET.Element(tag('p:embeddedFontLst'))
    # Schema ordering puts the embedded font list after the size elements.
    insert=next((i for i,e in enumerate(presentation) if e.tag in [tag('p:custShowLst'),tag('p:photoAlbum'),tag('p:defaultTextStyle'),tag('p:extLst')]),len(presentation))
    presentation.insert(insert,embed)
    rels=ET.fromstring(parts['ppt/_rels/presentation.xml.rels']);relsns='{http://schemas.openxmlformats.org/package/2006/relationships}'
    ct=ET.fromstring(parts['[Content_Types].xml']);ctns='{http://schemas.openxmlformats.org/package/2006/content-types}'
    for i,font in enumerate(plan['fonts']):
        file=f'ppt/fonts/font{i+1}.fntdata';rid=f'rIdMPFont{i+1}'
        parts[file]=eot_font(font['path'])
        ET.SubElement(ct,ctns+'Override',{'PartName':'/'+file,'ContentType':'application/x-fontdata'})
        ET.SubElement(rels,relsns+'Relationship',{'Id':rid,'Type':NS['r']+'/font','Target':f'fonts/font{i+1}.fntdata'})
        item=add(embed,'p:embeddedFont');add(item,'p:font',{'typeface':font['family'],'pitchFamily':34,'charset':0})
        slot='boldItalic' if font['bold'] and font['italic'] else 'bold' if font['bold'] else 'italic' if font['italic'] else 'regular'
        add(item,'p:'+slot,{'{'+NS['r']+'}id':rid})
    parts['ppt/presentation.xml']=xml(presentation)
    ET.register_namespace('',relsns[1:-1]);parts['ppt/_rels/presentation.xml.rels']=xml(rels)
    ET.register_namespace('',ctns[1:-1]);parts['[Content_Types].xml']=xml(ct)
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as z:
        for name,data in parts.items():z.writestr(name,data)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['prepare','finish']);parser.add_argument('input');parser.add_argument('output');parser.add_argument('--candidate');args=parser.parse_args()
    if args.mode=='prepare':
        payload=json.loads(Path(args.input).read_text());out=Path(args.output);plan=prepare(payload,Path(payload.get('fontCacheDirectory',out.parent/'fonts')))
        out.write_text(json.dumps(plan))
    else:finish(json.loads(Path(args.input).read_text()),args.candidate,args.output)
