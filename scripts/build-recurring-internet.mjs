import {build} from 'esbuild';
import {copyFile} from 'node:fs/promises';
await build({entryPoints:['src/recurring-internet.jsx'],bundle:true,jsx:'automatic',minify:true,format:'iife',target:['chrome120','safari17'],outfile:'web/internet-task/task.js',loader:{'.woff2':'file'},assetNames:'fonts/[name]-[hash]',define:{'process.env.NODE_ENV':'"production"'},legalComments:'eof'});
console.log('Internet task UI built into web/internet-task/');
await copyFile('node_modules/@astryxdesign/theme-neutral/fonts/figtree.LICENSE.txt','web/internet-task/fonts/Figtree-LICENSE.txt');
