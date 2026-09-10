"""Apply the pinned consolidator to saved editor geometry. JSON in/out only.

No run folders, source images, OCR, refitting, or model clients are involved.
"""
import copy
import hashlib
import json
import sys
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path


def offline_only(event, args):
    if event in ('socket.connect', 'socket.getaddrinfo', 'subprocess.Popen', 'os.system'):
        raise RuntimeError('Font consolidation is offline only')


sys.addaudithook(offline_only)
sys.path.insert(0, str(Path(sys.argv[1])/'scripts/matching'))
import font_consolidation as fc
from resolved_layout import word_metrics


@lru_cache(maxsize=None)
def measure(path, index, text, em):
    return list(word_metrics({'path':path,'face_index':index},text,em)[1])


def transform(obj, canvas, fonts):
    if obj.get('locked'):
        return None, 'skipped', 'locked'
    runs = (obj.get('resolved') or {}).get('words', [])
    if not runs:
        return None, 'skipped', 'no_saved_geometry'
    rows = OrderedDict()
    for i, word in enumerate(runs):
        rows.setdefault(word['line'], []).append(i)
    text = '\n'.join(' '.join(runs[i]['text'] for i in ids) for ids in rows.values())
    if text != obj['text']:
        return None, 'skipped', 'text_changed'
    if len({w['fontId'] for w in runs}) <= 1:
        return None, 'alreadyUniform', 'already_uniform'
    if len({w['scaleX'] for w in runs}) != 1:
        return None, 'skipped', 'incompatible_transforms'
    if any(w['fontId'] not in fonts for w in runs):
        return None, 'skipped', 'missing_font'
    # SVG applies scaleX after rotation. Normalize the entire coordinate plane
    # by this common scale so the pipeline's rotation and extent math is exact.
    scale = runs[0]['scaleX']
    frame = obj['frame']
    layout = {'schema':1,'page_size':[canvas['width']/scale,canvas['height']],
              'fonts':{w['fontId']:fonts[w['fontId']] for w in runs},'words':{},
              'blocks':[{'id':obj['id'],'align':obj['style']['align'],
                         'lines':[{'id':line,'words':ids} for line,ids in rows.items()]}]}
    for i,word in enumerate(runs):
        font = fonts[word['fontId']]
        layout['words'][str(i)] = {
            'id':i,'text':word['text'],'font':word['fontId'],'em':word['em'],
            'baseline':[(frame['x']+word['baseline'][0])/scale,frame['y']+word['baseline'][1]],
            'bounds':measure(font['path'],font.get('face_index',0),word['text'],word['em']),
            'angle':word['angle'],'line':word['line']}
    changed,report = fc.consolidate(layout,True)
    decision = report['blocks'][0]
    if decision['status'] != 'consolidated':
        return None, 'preserved', decision['reason']
    words = [changed['words'][str(i)] for i in range(len(runs))]
    a,b,c,d = fc.bounds(words)
    new_frame = {'x':a*scale,'y':b,'width':max(1,(c-a)*scale),'height':max(1,d-b)}
    result = copy.deepcopy(obj)
    result['frame'] = new_frame
    result['style']['fontId'] = words[0]['font']
    for run,word in zip(result['resolved']['words'],words):
        run['fontId'] = word['font']
        run['baseline'] = [word['baseline'][0]*scale-new_frame['x'],word['baseline'][1]-new_frame['y']]
    signature = json.dumps([new_frame,result['resolved']['words']],sort_keys=True).encode()
    result['resolved']['revision'] = 'consolidated-'+hashlib.sha256(signature).hexdigest()
    return result, 'consolidated', 'within_width_tolerance'


def run(payload):
    slides = []
    for slide in payload['slides']:
        updates,decisions = [],[]
        counts = dict(consolidated=0,alreadyUniform=0,preserved=0,skipped=0)
        for obj in slide['objects']:
            replacement,status,reason = transform(obj,slide['canvas'],payload['fonts'])
            counts[status] += 1
            decisions.append({'objectId':obj['id'],'status':status,'reason':reason})
            if replacement: updates.append(replacement)
        slides.append({'id':slide['id'],'updates':updates,'counts':counts,'decisions':decisions})
    return {'slides':slides}


if __name__ == '__main__':
    print(json.dumps(run(json.load(sys.stdin))))
