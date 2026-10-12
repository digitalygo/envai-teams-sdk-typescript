import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [pack]=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json'],{encoding:'utf8'}));
const expected=['package.json','README.md','LICENSE','dist/index.js','dist/index.d.ts','contracts/events.json'];
for(const path of expected)if(!pack.files.some(f=>f.path===path))throw Error('Missing packed file: '+path);
if(pack.files.some(f=>/^(tests|node_modules)\//.test(f.path)))throw Error('Unexpected development files packed');
const target=mkdtempSync(resolve('.package-smoke-'));
try{
 execFileSync('tar',['-xzf',pack.filename,'-C',target]);
 const module=await import(pathToFileURL(resolve(target,'package/dist/index.js')));
 if(Object.keys(module.operations).length!==52)throw Error('Packaged inventory mismatch');
 const test=JSON.parse(readFileSync('testdata/contracts/events-valid.json','utf8'))[0];
 if(module.parseEvent(test).type!=='ping')throw Error('Packaged schema unavailable');
 console.log(`Packed import verified: ${pack.filename}, ${pack.files.length} files`);
}finally{rmSync(target,{recursive:true,force:true});rmSync(pack.filename);}
