import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
 createCovenant,evaluateCovenant,compareSnapshots,checkApplicationObservations,
 inspectDependencies,rescueGraph,semanticCompare,diagnoseCompatibility,
 runCounterfactuals,blindCommitment,evaluateCutover,createProofCapsule,verifyProofCapsule
} from '../src/assurance/foundation.js';

const raw={id:'invoice_migration',revision:1,source:'csv',target:'sqlite',keyFields:['id'],
 rules:[{id:'count',type:'row_count_equal'},{id:'balance',type:'sum_equal',field:'amount',scale:2},
        {id:'amount',type:'field_equal',field:'amount'},{id:'unique_id',type:'unique',fields:['id']}],
 dependencies:[{id:'invoice_api',critical:true}]};
const cov=createCovenant(raw);
const src=[{id:'0001',amount:'20.30'},{id:'0002',amount:'10.10'}];
const dst=structuredClone(src);
test('covenant is domain-hashed, deterministic and immutable',()=>{
 assert.equal(cov.covenantDigest,createCovenant(raw).covenantDigest);
 assert.ok(Object.isFrozen(cov.rules[0]));assert.match(cov.covenantDigest,/^sha256:/);
});
test('unknown covenant rules fail closed',()=>{
 assert.throws(()=>createCovenant({...raw,rules:[{id:'delete_all',type:'execute_sql'}]}),/Unsupported/);
 assert.throws(()=>createCovenant({...raw,unknown:'x'}),/Unsupported/);
 assert.throws(()=>createCovenant({...raw,rules:[{id:'count',type:'row_count_equal'},{id:'count',type:'unique',fields:['id']}]}),/unique/);
});
test('valid dataset evaluation is VERIFIED with no raw rows in output',()=>{
 const result=evaluateCovenant(cov,{sourceRows:src,targetRows:dst});
 assert.equal(result.status,'VERIFIED');assert.equal(result.checkedRules,4);
 assert.ok(!JSON.stringify(result).includes('20.30'));
 assert.ok(!JSON.stringify(result).includes('0001'));
});
test('subtle amount change with same counts is MISMATCH',()=>{
 const wrong=structuredClone(dst);wrong[0].amount='20.31';wrong[1].amount='10.09';
 const result=evaluateCovenant(cov,{sourceRows:src,targetRows:wrong});
 assert.equal(result.status,'MISMATCH');
 assert.equal(result.findings.find(f=>f.id==='count').status,'VERIFIED');
 assert.equal(result.findings.find(f=>f.id==='balance').status,'VERIFIED');
 assert.equal(result.findings.find(f=>f.id==='amount').status,'MISMATCH');
});
test('missing evidence stays NOT_VERIFIED rather than green',()=>{
 assert.equal(evaluateCovenant(cov,{}).status,'NOT_VERIFIED');
});
test('duplicate identities are indeterminate rather than silently merged',()=>{
 const a=compareSnapshots({sourceRows:src,targetRows:[...dst,dst[0]],keyFields:['id']});
 assert.equal(a.status,'INDETERMINATE');assert.equal(a.ambiguousTargetKeys,1);
 assert.equal(rescueGraph({sourceRows:src,targetRows:[...dst,dst[0]],keyFields:['id']}).mayAutoReplay,false);
});
test('snapshot diff counts omissions extras and modifications',()=>{
 const a=compareSnapshots({sourceRows:src,targetRows:[{id:'0001',amount:'20.31'},{id:'0009',amount:'1.00'}],keyFields:['id']});
 assert.deepEqual([a.divergent,a.absent,a.extra],[1,1,1]);
 assert.equal(a.status,'MISMATCH');
});
test('snapshot diff never discloses record keys or values',()=>{
 const a=rescueGraph({sourceRows:src,targetRows:[],keyFields:['id']});
 assert.equal(a.recommendedAction,'REVIEW_DIFFERENCES_BEFORE_APPROVAL');assert.deepEqual(a.mutations,[]);
 assert.ok(!JSON.stringify(a).includes('0001'));
});
test('exact money comparisons reject float rounding and accidental conversion',()=>{
 assert.equal(semanticCompare({kind:'money',source:'0.30',target:'0.30',scale:2}).status,'VERIFIED');
 assert.equal(semanticCompare({kind:'money',source:'0.30',target:'0.3',scale:2}).status,'VERIFIED');
 assert.equal(semanticCompare({kind:'money',source:'0.30',target:'0.3000000004',scale:2}).status,'INDETERMINATE');
 assert.equal(semanticCompare({kind:'money',source:0.3,target:'0.30',scale:2}).status,'INDETERMINATE');
});
test('date equivalence requires explicit offsets',()=>{
 assert.equal(semanticCompare({kind:'instant',source:'2026-10-15T10:00:00+05:30',target:'2026-10-15T04:30:00Z'}).status,'VERIFIED');
 assert.equal(semanticCompare({kind:'instant',source:'2026-10-15T10:00:00',target:'2026-10-15T04:30:00Z'}).status,'INDETERMINATE');
});
test('leading-zero identifiers remain non-equivalent',()=>{
 assert.equal(semanticCompare({kind:'identifier',source:'0008',target:'8'}).status,'MISMATCH');
});
test('reference closure detects orphaned entities',()=>{
 const x=createCovenant({id:'rel',revision:1,source:'files',target:'sqlite',keyFields:['id'],
 rules:[{id:'rels',type:'reference_complete',child:'orders',parent:'customers',childField:'customerId',parentField:'id'}]});
 const r=evaluateCovenant(x,{collections:{orders:[{id:'o',customerId:'missing'}],customers:[{id:'different'}]}});
 assert.equal(r.status,'MISMATCH');assert.equal(r.findings[0].affected,1);
});
test('recorded shadow observations detect workflow divergence without executing applications',()=>{
 const s=checkApplicationObservations([{id:'api',source:{status:200,body:'ok'},target:{status:500,body:'no'}}]);
 assert.equal(s.status,'MISMATCH');assert.equal(s.liveApplicationExecuted,false);
});
test('missing critical consumer blocks declared dependency closure',()=>{
 const d=inspectDependencies([{id:'api',critical:true}],[]);
 assert.equal(d.status,'INDETERMINATE');assert.deepEqual(d.criticalBlockers,['api']);
});
test('unknown dependency status blocks declared closure',()=>{
 const d=inspectDependencies([{id:'api',critical:true}],[{id:'api',status:'NOT_VERIFIED'}]);
 assert.equal(d.status,'INDETERMINATE');
});
test('version mismatch in compatibility rules cannot silently pass',()=>{
 const pack={id:'example',target:'shopify',version:'example-fixture-1',rules:[{id:'duplicate',code:'DUPLICATE_KEY',severity:'BLOCK',remedy:'Review keys'}]};
 assert.equal(diagnoseCompatibility(pack,{target:'shopify',version:'other',codes:[]}).status,'INDETERMINATE');
 const r=diagnoseCompatibility(pack,{target:'shopify',version:'example-fixture-1',codes:['DUPLICATE_KEY']});
 assert.equal(r.status,'MISMATCH');assert.equal(r.matches.length,1);
 assert.equal(diagnoseCompatibility(pack,{target:'shopify',version:'example-fixture-1',codes:[]}).status,'NOT_VERIFIED');
});
test('counterfactual lab injects detectable faults but does not claim database qualification',()=>{
 const r=runCounterfactuals(cov,{sourceRows:src,targetRows:dst});
 assert.equal(r.simulationOnly,true);assert.equal(r.realDatabaseFaultsTested,false);
 assert.equal(r.results.find(x=>x.scenario==='unaltered').snapshot,'VERIFIED');
 assert.equal(r.results.find(x=>x.scenario==='target_first_row_modified').snapshot,'MISMATCH');
});
test('blind commitments demand independent secret and avoid exporting it',()=>{
 assert.throws(()=>blindCommitment({key:Buffer.from('short'),namespace:'tenant1',value:{x:1}}),/32 bytes/);
 const key=randomBytes(32),a=blindCommitment({key,namespace:'tenant1',value:{x:1}});
 assert.equal(a.digest.length,64);assert.ok(!JSON.stringify(a).includes(key.toString('hex')));
 assert.equal(a.zeroKnowledgeProof,false);
});
test('cutover decisions are advisory and reject conflated roles',()=>{
 const e=evaluateCovenant(cov,{sourceRows:src,targetRows:dst});
 const d=inspectDependencies([{id:'api',critical:true}],[{id:'api',status:'VERIFIED'}]);
 const blocked=evaluateCutover({evaluation:e,dependencies:d,executedBy:'a',verifiedBy:'a',approvedBy:'b',rollbackReady:true,changeWindowApproved:true});
 assert.equal(blocked.decision,'HOLD');assert.equal(blocked.mutationsAuthorized,false);
 const advisory=evaluateCutover({evaluation:e,dependencies:d,executedBy:'a',verifiedBy:'b',approvedBy:'c',rollbackReady:true,changeWindowApproved:true});
 assert.equal(advisory.decision,'ADVISORY_READY');assert.equal(advisory.identityAuthenticated,false);
});
test('signed proof capsule verifies offline with enrolled public key and tampering fails',()=>{
 const evaluation=evaluateCovenant(cov,{sourceRows:src,targetRows:dst});
 const deps=inspectDependencies([{id:'invoice_api',critical:true}],[{id:'invoice_api',status:'VERIFIED'}]);
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 const cap=createProofCapsule({covenant:cov,evaluation,dependencies:deps,releaseCommit:'a'.repeat(40),observedAt:'2026-10-15T11:00:00Z',operator:'reviewer'},privateKey);
 assert.equal(cap.signatureStatus,'SIGNED');assert.equal(verifyProofCapsule(cap,publicKey).verified,true);
 const forged=structuredClone(cap);forged.payload.decision='MISMATCH';
 assert.equal(verifyProofCapsule(forged,publicKey).reason,'PAYLOAD_TAMPERED');
 assert.ok(!JSON.stringify(cap).includes('20.30'));
});
test('unsigned proof capsule never passes verification',()=>{
 const evaluation=evaluateCovenant(cov,{sourceRows:src,targetRows:dst}), deps=inspectDependencies([],[]);
 const cap=createProofCapsule({covenant:cov,evaluation,dependencies:deps,releaseCommit:'b'.repeat(40),observedAt:'2026-10-15T11:00:00Z',operator:'reviewer'});
 assert.equal(cap.signatureStatus,'UNSIGNED');assert.equal(verifyProofCapsule(cap).verified,false);
});
test('test data size is capped and invalid rules cannot trigger arbitrary code',()=>{
 const huge=Array.from({length:10001},(_,i)=>({id:String(i)}));
 assert.throws(()=>compareSnapshots({sourceRows:huge,targetRows:[],keyFields:['id']}),/limit|bounded/i);
 assert.throws(()=>createCovenant({...raw,rules:[{id:'x',type:'field_equal',field:'id',constructor:'x'}]}),/Unsupported/);
});
