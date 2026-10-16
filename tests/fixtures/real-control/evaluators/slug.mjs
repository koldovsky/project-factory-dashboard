import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const {slug}=await import(pathToFileURL(path.join(process.env.FACTORY_CANDIDATE_DIR,'slug.mjs')).href);
const checks=[
  ['trim-case',()=>assert.equal(slug('  Hello World  '),'hello-world')],
  ['spaces',()=>assert.equal(slug('many   spaces'),'many-spaces')],
  ['punctuation',()=>assert.equal(slug('Hello, world!'),'hello-world')],
  ['invalid-input',()=>assert.throws(()=>slug(null),TypeError)]
];
const cases=checks.map(([id,check])=>{try{check();return{id,status:'passed'};}catch(error){return{id,status:'failed',details:error.message};}});
const status=cases.every(c=>c.status==='passed')?'passed':'failed';
console.log(JSON.stringify({status,cases}));process.exitCode=status==='passed'?0:1;
