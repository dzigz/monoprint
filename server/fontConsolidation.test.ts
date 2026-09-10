import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Deck, TextObject } from "../src/shared/types.js";
import { currentFocusRegions, focusInputKey, parseFocusCues } from "../src/shared/focusRegions.js";
import { mergeServerDeck } from "../src/shared/merge.js";
import { DeckStore } from "./deckStore.js";
import { DeckMutations } from "./deckMutations.js";
import type { FontRegistry } from "./fonts.js";
import { FocusRegionManager } from "./focusRegionManager.js";
import { FontConsolidation, type ConsolidationInput, type ConsolidationOutput } from "./fontConsolidation.js";

function fixture(): Deck {
  const role = { fontId:"sans",family:"Sans",weight:400,style:"normal" as const,letterSpacing:0 };
  const object: TextObject = { id:"text",kind:"text",text:"Long line\nShort",frame:{x:10,y:10,width:150,height:55},origin:{kind:"recovered"},
    style:{fontRole:"body",fontId:"one",fontSize:20,lineHeight:1.2,align:"left",color:"#111111"},
    resolved:{revision:"original",words:["Long line","Short"].map((text,i)=>({id:i,text,fontId:i?"two":"one",em:20,baseline:[0,20+i*25],angle:0,color:"#111111",line:String(i),scaleX:1}))} };
  const deck: Deck = { schemaVersion:4,id:"test-deck",title:"Test",brief:{prompt:"Test",attachments:[]},
    designSystem:{name:"Test",creativeDirection:"Test",rationale:"Test",imageTreatment:"Test",principles:["Test"],
      typography:{relationship:"single-family",rationale:"Test",display:role,heading:role,body:role,label:role},
      colors:{background:"#ffffff",surface:"#eeeeee",text:"#111111",mutedText:"#777777",accent:"#0000ff",accentText:"#ffffff",border:"#888888"}},
    fonts:["one","two"].map(id=>({id,catalogId:id,family:"Sans",subfamily:"Regular",weight:400,style:"normal",url:"/font.ttf",source:"catalog"})),
    assets:[1,2].map(i=>({id:`asset${i}`,slideId:`slide${i}`,kind:"slide-image",url:`/api/assets/test-deck/slide${i}.png`,prompt:"Test",copy:[],alt:"Test",width:400,height:200})),slides:[1,2].map(i=>({id:`slide${i}`,title:"Slide",purpose:"Test",copy:[],assetId:`asset${i}`,canvas:{width:400,height:200},state:"recovered",
      recovery:{status:"recovered",updatedAt:"2026-09-10T00:00:00.000Z"},version:1,history:[],talkingPoints:"**[Section]** Explain this section.",layers:{plateAssetId:"plate",objects:[structuredClone(object)]}})),
    createdAt:"2026-09-10T00:00:00.000Z",updatedAt:"2026-09-10T00:00:00.000Z",revision:0 };
  for (const slide of deck.slides) slide.focusRegions={inputKey:focusInputKey(deck,slide),status:"ready",regions:[{cueId:parseFocusCues(slide.talkingPoints)[0].id,box:[0,0,200,100]}],updatedAt:deck.updatedAt};
  return deck;
}
const execute = async (input:ConsolidationInput):Promise<ConsolidationOutput> => ({slides:input.slides.map(slide=>({id:slide.id,
  counts:{consolidated:1,alreadyUniform:0,preserved:0,skipped:0},
  updates:slide.objects.map(object=>({...object,frame:{...object.frame,width:151},resolved:{...object.resolved!,revision:"consolidated",words:object.resolved!.words.map(word=>({...word,fontId:"one"}))}}))}))});

async function harness(t:test.TestContext, options:{enabled?:boolean;execute?:typeof execute;deck?:Deck}={}) {
  const root=await mkdtemp(path.join(tmpdir(),"monoprint-consolidation-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new DeckStore(root);
  const fonts={ensureDeckFonts:(deck:Deck)=>deck,catalogFilePath:()=>({path:"/test/font.ttf",faceIndex:0})} as unknown as FontRegistry;
  const mutations=new DeckMutations(store,fonts);
  const deck=options.deck??fixture();await store.save(deck);
  const service=new FontConsolidation(store,mutations,fonts,{projectRoot:process.cwd(),enabled:options.enabled??true,execute:options.execute??execute});
  return {store,mutations,deck,service};
}

test("one-slide consolidation preserves the other slide, images, metadata and current highlights; Undo restores its cache",async t=>{
  const {service,deck,store,mutations}=await harness(t);
  const result=await service.run(deck.id,["slide1"],deck.revision);
  assert.equal(result.summary.consolidated,1);
  assert.deepEqual(result.deck.slides[1],deck.slides[1]);
  assert.deepEqual(result.deck.assets,deck.assets);
  assert.deepEqual(result.deck.slides[0].recovery,deck.slides[0].recovery);
  assert.equal(result.deck.slides[0].layers!.plateAssetId,"plate");
  assert.deepEqual(currentFocusRegions(result.deck,result.deck.slides[0]),deck.slides[0].focusRegions!.regions);
  let calls=0;
  const manager=new FocusRegionManager(store,mutations,{locate:async()=>{calls++;return []},readImage:async()=>""});
  t.after(()=>manager.dispose());
  await manager.ensureDeck(deck.id);
  assert.equal(calls,0);
  const undone=mergeServerDeck(deck,result.deck);
  assert.deepEqual(undone.slides[0].layers,deck.slides[0].layers);
  assert.deepEqual(currentFocusRegions(undone,undone.slides[0]),deck.slides[0].focusRegions!.regions);
  await mutations.mutate(deck.id,()=>undone);
  await manager.ensureDeck(deck.id);
  assert.equal(calls,0);
});

test("whole-deck scope and no-op results do not make unnecessary revisions",async t=>{
  const all=await harness(t);
  const result=await all.service.run(all.deck.id,undefined,0);
  assert.equal(result.summary.slides,2);assert.equal(result.summary.consolidated,2);
  const none=await harness(t,{execute:async input=>({slides:input.slides.map(s=>({id:s.id,updates:[],counts:{consolidated:0,alreadyUniform:1,preserved:0,skipped:0}}))})});
  assert.equal((await none.service.run(none.deck.id,undefined,0)).deck.revision,0);
});

test("failed export preparation rolls back consolidation; preparation also runs for uniform decks",async t=>{
  const {service,store,deck}=await harness(t);
  await assert.rejects(()=>service.run(deck.id,undefined,0,async candidate=>{
    assert.equal(candidate.slides[0].layers!.objects[0].resolved!.revision,"consolidated");
    throw new Error("Export failed");
  }),/Export failed/);
  assert.deepEqual(await store.load(deck.id),deck);
  const uniform=await harness(t,{execute:async input=>({slides:input.slides.map(s=>({id:s.id,updates:[],counts:{consolidated:0,alreadyUniform:1,preserved:0,skipped:0}}))})});
  let called=false;
  await uniform.service.run(deck.id,undefined,0,async()=>{called=true;});assert.equal(called,true);
});

test("flag OFF, stale versions and active recovery never invoke the worker",async t=>{
  let calls=0; const worker=async(input:ConsolidationInput)=>{calls++;return execute(input)};
  const off=await harness(t,{enabled:false,execute:worker});
  await assert.rejects(()=>off.service.run(off.deck.id,undefined,0),/disabled/);
  const stale=await harness(t,{execute:worker});
  await assert.rejects(()=>stale.service.run(stale.deck.id,undefined,99),/deck changed/);
  const deck=fixture();deck.slides[0].recovery.status="running";
  const busy=await harness(t,{deck,execute:worker});
  await assert.rejects(()=>busy.service.run(deck.id,undefined,0),/Wait for text recovery/);
  assert.equal(calls,0);
});

test("worker failure leaves the stored deck untouched",async t=>{
  const {service,deck,store}=await harness(t,{execute:async()=>{throw new Error("worker stopped")}});
  await assert.rejects(()=>service.run(deck.id,undefined,0),/worker stopped/);
  assert.deepEqual(await store.load(deck.id),deck);
});

test("missing cached highlights require a manual retry instead of calling a model",async t=>{
  const deck=fixture();delete deck.slides[0].focusRegions;
  const {service,store,mutations}=await harness(t,{deck});
  const result=await service.run(deck.id,["slide1"],0);
  assert.equal(result.deck.slides[0].focusRegions?.status,"failed");
  let calls=0;
  const manager=new FocusRegionManager(store,mutations,{locate:async()=>{calls++;return []},readImage:async()=>""});
  t.after(()=>manager.dispose());
  await manager.ensureDeck(deck.id);
  assert.equal(calls,0);
});
