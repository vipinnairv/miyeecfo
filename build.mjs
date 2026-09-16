#!/usr/bin/env node
/* Build step for MiyeeCFO.
   The app's UI lives as JSX in src/app.jsx (the source of truth). This script
   transpiles it once and inlines plain JavaScript into index.html between the
   APP markers, so browsers never load Babel or compile at runtime. Run it after
   any edit to src/app.jsx:  node build.mjs                                    */
import {transform} from '@babel/standalone';
import fs from 'node:fs';

// The pure engine (plain JS) is concatenated ahead of the JSX UI so both ship
// as one inline script, and the engine stays independently testable.
const engine=fs.readFileSync('src/engine.js','utf8');
const jsx=engine+'\n'+fs.readFileSync('src/app.jsx','utf8');
const t=Date.now();
const code=transform(jsx,{presets:['react'],compact:false}).code;
console.log(`Transpiled src/engine.js + src/app.jsx in ${Date.now()-t}ms (${code.length} chars)`);

let html=fs.readFileSync('index.html','utf8');
const START='/*__APP_START__*/',END='/*__APP_END__*/';
const block=`<script id="app">${START}\n${code}\n${END}</script>`;
if(html.includes(START)&&html.includes(END)){
  html=html.replace(new RegExp('<script id="app">[\\s\\S]*?'+END.replace(/[/*]/g,'\\$&')+'</script>'),()=>block);
}else{
  // First build: replace the legacy Babel script tag.
  html=html.replace(/<script type="text\/babel">[\s\S]*?<\/script>/,()=>block);
}
fs.writeFileSync('index.html',html);
console.log('Injected compiled app into index.html');
