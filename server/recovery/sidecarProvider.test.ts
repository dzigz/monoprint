import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { SidecarRecoveryProvider } from './sidecarProvider.js';
import type { RecoveryInput } from './provider.js';

test('offline reuse delivers the saved plate and exact layout, and rejects changed decisions or an unreviewed revision', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'resolved-reuse-'));
  try {
    const doc=path.join(root,'test_asset');await mkdir(doc);const output=path.join(root,'output');await mkdir(output);
    const image=await sharp({create:{width:80,height:40,channels:3,background:'#eeeeee'}}).png().toBuffer();
    const page=path.join(doc,'page.png');await writeFile(page,image);await writeFile(path.join(doc,'match_A_plate.png'),image);
    const fontPath='/System/Library/Fonts/Supplemental/Arial.ttf';
    const hash=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
    const fontHash=hash(await readFile(fontPath));
    const layout={schema:1,page_size:[80,40],fonts:{f:{path:fontPath,face_index:0,sha256:fontHash}},
      words:{0:{id:0,text:'test',font:'f',em:20,baseline:[12,25],bounds:[0,-15,32,0],angle:4,color:[20,30,40],line:'1:0'}},
      blocks:[{id:1,role:'label',align:'left',lines:[{id:'1:0',words:[0]}]}]};
    const layoutBytes=JSON.stringify(layout);await writeFile(path.join(doc,'resolved_layout.json'),layoutBytes);
    const state={schema:4,revision:'reviewed',assets:{'resolved_layout.json':hash(layoutBytes),'match_A_plate.png':hash(image)},code_files:{},input_files:{'design_overrides.json':null},source_fonts:{[fontPath]:fontHash}};
    await writeFile(path.join(doc,'render_state.json'),JSON.stringify(state));
    const report={status:'reviewed',revision:'reviewed',reviewed_revision:'reviewed'};
    await writeFile(path.join(doc,'design_report.json'),JSON.stringify(report));
    const fontRegistry={registerFittedFont:async()=>({id:'fitted',family:'Arial',subfamily:'Regular',weight:400,style:'normal',url:'font.ttf'})};
    const provider=new SidecarRecoveryProvider({baseUrl:'http://127.0.0.1:1',runsDirectory:root,docPrefix:'test',reuseRuns:true,designAgent:true,fontRegistry:fontRegistry as any});
    provider.health=async()=>({available:false,detail:'offline test'});
    (provider as any).callReconstruct=async()=>{throw new Error('reconstruction required');};
    const input:RecoveryInput={deckId:'deck-123456',slideId:'slide',assetId:'asset',canvas:{width:80,height:40},imagePath:page,copy:[{role:'label',text:'test',fontRole:'label'}],colors:{} as any,
      fonts:[{role:'label',catalogId:'arial',family:'Arial',subfamily:'Regular',weight:400,style:'normal',path:fontPath,faceIndex:0}],outputDirectory:output};
    await writeFile(path.join(doc,'request.json'),JSON.stringify({image:hash(image),known:provider.buildKnownPayload(input),deck:input.deckId.slice(0,8),fonts:{[fontPath]:fontHash},designAgent:true}));
    const result=await provider.recover(input);
    assert.equal(result.diagnostics?.revision,'reviewed');assert.equal(result.diagnostics?.plateFilledPixels,0);
    assert.equal(result.objects[0].kind,'text');
    if(result.objects[0].kind==='text') {
      const word=result.objects[0].resolved!.words[0];
      assert.equal(word.em,20);assert.equal(word.angle,4);
      assert.equal(result.objects[0].frame.x+word.baseline[0],12);
    }
    assert.deepEqual(await sharp(result.platePath).raw().toBuffer(),await sharp(image).raw().toBuffer());
    await writeFile(path.join(doc,'design_overrides.json'),'{}');
    await assert.rejects(provider.recover(input),/reconstruction required/);
    await rm(path.join(doc,'design_overrides.json'));
    await writeFile(path.join(doc,'design_report.json'),JSON.stringify({...report,reviewed_revision:'previous'}));
    await assert.rejects(provider.recover(input),/reconstruction required/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
