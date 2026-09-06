import assert from "node:assert/strict";
import test from "node:test";
import { objectsFromResolved, type PipelineLayout } from "./resolvedLayout.js";
import { applyCommand, textObjectSchema } from "../../src/shared/commands.js";
import type { Deck, DeckFont } from "../../src/shared/types.js";

const fonts = new Map<string, DeckFont>(["one", "two"].map((id) => [id, {
  id, family: "Test", subfamily: "Regular", weight: 400, style: "normal", url: "/test.ttf", source: "fitted",
}]));
const layout: PipelineLayout = {
  schema: 1, page_size: [800,600], fonts: {},
  words: {
    "2": { id: 2, text: "Mixed", font: "one", em: 40, baseline: [120,180], bounds: [0,-30,100,5], angle: -8, color: [20,30,40], line: "1:0" },
    "8": { id: 8, text: "24", font: "two", em: 22, baseline: [246,180], bounds: [0,-16,27,0], angle: -8, color: [90,10,20], line: "1:0" },
  }, blocks: [{ id: 1, role: "heading", align: "left", lines: [{ id: "1:0", words: [2,8] }] }],
};

test("canonical export preserves mixed sizes, exact fonts, baseline offsets and rotation", () => {
  const [object] = objectsFromResolved(layout, fonts, { width: 1600, height: 1200 }, "revision");
  assert.equal(object.text, "Mixed 24");
  assert.equal(object.resolved!.words[0].em,80);
  assert.equal(object.resolved!.words[1].em,44);
  assert.equal(object.resolved!.words[1].fontId,"two");
  assert.equal(object.resolved!.words[0].angle,-8);
  for (const run of object.resolved!.words) {
    assert.equal(run.baseline[0]+object.frame.x,layout.words[run.id].baseline[0]*2);
    assert.equal(run.baseline[1]+object.frame.y,layout.words[run.id].baseline[1]*2);
  }
  assert.deepEqual(textObjectSchema.parse(object),object);
});

test("moving and recoloring preserve resolved geometry; content and width edits reflow", () => {
  const [object] = objectsFromResolved(layout,fonts,{ width: 800,height: 600 },"r");
  const deck={ slides:[{ id:"s",canvas:{ width:800,height:600 },layers:{ plateAssetId:"p",objects:[object] } }] } as Deck;
  const get=(value:Deck) => value.slides[0].layers!.objects[0];
  const moved=get(applyCommand(deck,{ type:"move_object",slideId:"s",objectId:object.id,x:200,y:230 }));
  assert.deepEqual(moved.resolved,object.resolved);
  const same=get(applyCommand(deck,{ type:"set_text",slideId:"s",objectId:object.id,text:object.text }));
  assert.deepEqual(same.resolved,object.resolved);
  const edited=get(applyCommand(deck,{ type:"set_text",slideId:"s",objectId:object.id,text:"Different" }));
  assert.equal(edited.resolved,undefined);
  const colored=get(applyCommand(deck,{ type:"set_text_style",slideId:"s",objectId:object.id,style:{ color:"#abcdef" } }));
  assert.deepEqual(colored.resolved!.words.map((w)=>w.color),["#abcdef","#abcdef"]);
  assert.deepEqual(colored.resolved!.words.map((w)=>w.baseline),object.resolved!.words.map((w)=>w.baseline));
  const resized=get(applyCommand(deck,{ type:"resize_object",slideId:"s",objectId:object.id,frame:{ ...object.frame,width:400 } }));
  assert.equal(resized.resolved,undefined);
});
