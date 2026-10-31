import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [pack]=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json'],{encoding:'utf8'}));
const expected=['package.json','README.md','LICENSE','dist/index.js','dist/index.d.ts','contracts/events.json','contracts/events-v2.json','contracts/wiki.json','contracts/terminal-snapshot.json','contracts/openapi-v2.json','migrations/wiki-webhook-inbox.sql','migrations/tool-state.sql','migrations/definition-state.sql','docs/WIKI.md','docs/MIGRATION_V3.md','docs/CHAT_ATTACHMENTS.md','docs/DEFINITIONS.md','dist/definition-cli.js'];
for(const path of expected)if(!pack.files.some(f=>f.path===path))throw Error('Missing packed file: '+path);
if(pack.files.some(f=>/^(tests|node_modules)\//.test(f.path)))throw Error('Unexpected development files packed');
const target=mkdtempSync(resolve('.package-smoke-'));
try{
 execFileSync('tar',['-xzf',pack.filename,'-C',target]);
 const module=await import(pathToFileURL(resolve(target,'package/dist/index.js')));
 if(Object.keys(module.operations).length!==76)throw Error('Packaged inventory mismatch');
 const test=JSON.parse(readFileSync('testdata/contracts/events-valid.json','utf8'))[0];
 if(module.parseEvent(test).type!=='ping')throw Error('Packaged legacy schema unavailable');
 if(module.parseEvent({...test,v:3}).v!==3)throw Error('Packaged contract 3 schema unavailable');
 const source=JSON.parse(readFileSync('testdata/wiki/source-accepted.json','utf8')).data;
 if(module.validateContractValue('WikiSource',source).file_id!==source.file_id)throw Error('Packaged wiki schema unavailable');
 for(const name of ['SQLDefinitionStateStore','SQLiteDefinitionStateStore','MySQLDefinitionStateStore','ClientDefinitionRemote','runDefinitionsCli','PostgresToolStateStore','FileDefinitionStateStore','PostgresDefinitionStateStore','DefinitionSynchronizer','compileDefinitions','PostgresWikiWebhookInbox','WikiWebhookVerifier','uploadSourceFile','waitForSource','waitForWikiOperation','uploadAttachmentFile','waitForAttachment'])if(typeof module[name]!=='function')throw Error('Missing packaged export: '+name);
 const localManifest=resolve(target,'empty-manifest.json');writeFileSync(localManifest,JSON.stringify({format_version:'1',tools:{},agents:{},teams:{}}));
 const validated=JSON.parse(execFileSync(process.execPath,[resolve(target,'package/dist/definition-cli.js'),'validate','--path',localManifest,'--json'],{encoding:'utf8'}));
 if(validated.status!=='valid'||validated.format_version!=='1')throw Error('Packaged CLI validation failed');
 console.log(`Packed import verified: ${pack.filename}, ${pack.files.length} files`);
}finally{rmSync(target,{recursive:true,force:true});rmSync(pack.filename);}
