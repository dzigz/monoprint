import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Deck } from "../src/shared/types.js";
import type { FontConsolidation } from "./fontConsolidation.js";
import { PptxExporter, assertExportable } from "./pptxExport.js";

const deck = () => ({id:"deck",title:"A / presentation",revision:3,slides:[{id:"slide",canvas:{width:1536,height:864},layers:{objects:[{style:{fontId:"consolidated"}}]}}]}) as unknown as Deck;
const report={slides:1,fonts:1,textBoxes:1,multilineBoxes:1,positionedWords:0};
const summary={slides:1,consolidated:1,alreadyUniform:0,preserved:0,skipped:0};

test("export always consolidates first, builds the supplied consolidated snapshot, and serves only its own deck",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"monoprint-pptx-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const order:string[]=[];const snapshot=deck();
  const consolidation={health:async()=>({available:true}),run:async(id,slides,revision,beforeSave)=>{
    assert.equal(id,"deck");assert.equal(slides,undefined);assert.equal(revision,2);
    order.push("consolidate");await beforeSave!(snapshot);order.push("save");return {deck:snapshot,summary};
  }} as Pick<FontConsolidation,"run"|"health"|"fontFile">;
  const exporter=new PptxExporter({directory:()=>root},consolidation,{projectRoot:root,build:async(d,out)=>{
    order.push("build");assert.equal(d,snapshot);assert.equal(d.slides[0].layers!.objects[0].style.fontId,"consolidated");
    await writeFile(path.join(out,"presentation.pptx"),"fixture");return report;
  }});
  const result=await exporter.run("deck",2);assert.deepEqual(order,["consolidate","build","save"]);
  const id=result.downloadUrl.split("/").at(-1)!;
  assert.match((await exporter.download("deck",id)).filename,/\.pptx$/);
  await assert.rejects(()=>exporter.download("another-deck",id),/not found/);
  await assert.rejects(()=>exporter.download("deck","../receipt.json"),/not found/);
});

test("consolidation failures never fall back to exporting the original deck",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"monoprint-pptx-failure-"));t.after(()=>rm(root,{recursive:true,force:true}));
  let builds=0;
  const consolidation={health:async()=>({available:true}),run:async()=>{throw new Error("consolidation failed");}} as unknown as Pick<FontConsolidation,"run"|"health"|"fontFile">;
  const exporter=new PptxExporter({directory:()=>root},consolidation,{projectRoot:root,build:async()=>{builds++;return report}});
  await assert.rejects(()=>exporter.run("deck",2),/PowerPoint export failed/);assert.equal(builds,0);
});

test("unavailable consolidation disables export",async()=>{
  const consolidation={health:async()=>({available:false,detail:"Consolidation disabled"})} as Pick<FontConsolidation,"run"|"health"|"fontFile">;
  const exporter=new PptxExporter({directory:()=>"/tmp"},consolidation,{projectRoot:"/tmp",build:async()=>report});
  await assert.rejects(()=>exporter.run("deck",2),/Consolidation disabled/);
});

test("export refuses unrecovered slides and incompatible page dimensions",()=>{
  const missing=deck();delete missing.slides[0].layers;assert.throws(()=>assertExportable(missing),/Recover text/);
  const mixed=deck();mixed.slides.push({...mixed.slides[0],canvas:{width:1200,height:800}});assert.throws(()=>assertExportable(mixed),/same canvas size/);
});
