import {build} from 'esbuild';
import {copyFile} from 'node:fs/promises';
await build({entryPoints:['src/astryx/main.jsx'],bundle:true,jsx:"automatic",minify:true,format:'iife',target:['chrome120','safari17'],outfile:'web/astryx/workspace.js',loader:{'.woff2':'file'},assetNames:'fonts/[name]-[hash]',define:{'process.env.NODE_ENV':'"production"'},legalComments:'eof'});
await copyFile('node_modules/@astryxdesign/theme-neutral/fonts/figtree.LICENSE.txt','web/astryx/fonts/Figtree-LICENSE.txt');
console.log('Astryx workspace built into web/astryx/');
