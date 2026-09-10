// Native text and background image authored through Artifact Tool; the Python
// finalizer adds exact paragraph/run spacing and full fitted-font embedding.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [planPath,output,moduleRoot]=process.argv.slice(2);
const {Presentation,PresentationFile}=await import(pathToFileURL(path.join(moduleRoot,'@oai/artifact-tool/dist/artifact_tool.mjs')).href);
const plan=JSON.parse(await fs.readFile(planPath,'utf8'));
const first=plan.slides[0];
const presentation=Presentation.create({slideSize:first.canvas});
for(const input of plan.slides){
  const slide=presentation.slides.add();
  slide.images.add({blob:new Uint8Array(await fs.readFile(input.background)),contentType:'image/png',alt:'Slide background',fit:'contain',
    position:{left:0,top:0,width:input.canvas.width,height:input.canvas.height}});
  for(const item of input.shapes){
    const shape=slide.shapes.add({name:item.name,geometry:'textbox',position:{left:item.left,top:item.top,width:item.width,height:item.height},fill:'none',line:{fill:'none',width:0}});
    shape.text=item.lines.map(line=>line.map(w=>w.text).join(' ')).join('\n');
    shape.text.style={typeface:item.font.family,fontSize:item.em,bold:item.font.bold,italic:item.font.italic,color:item.lines[0][0].color,
      wrap:'none',autoFit:'none',verticalAlignment:'top',insets:{left:0,right:0,top:0,bottom:0}};
    if(item.angle)shape.rotation=item.angle;
  }
  if(input.notes)slide.speakerNotes.textFrame.setText(input.notes);
}
await(await PresentationFile.exportPptx(presentation)).save(output);
