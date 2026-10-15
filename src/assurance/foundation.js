import { createHash, createHmac, sign, verify, createPublicKey } from 'node:crypto';
import { canonicalJson, sha256Canonical } from '../platform/canonical-json.js';

const MAX_ROWS = 10000;
const MAX_BYTES = 8 * 1024 * 1024;
const ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const STATE = new Set(['VERIFIED','MISMATCH','NOT_VERIFIED','INDETERMINATE']);
const TYPES = new Set(['row_count_equal','field_equal','sum_equal','unique','domain','reference_complete','application_equal']);

function bad(message) { const e = new Error(message); e.code = 'ASSURANCE_INVALID_INPUT'; throw e; }
function clean(input) {
  const json = canonicalJson(input);
  if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) bad('Assurance input exceeds the bounded 8 MiB evidence limit');
  return JSON.parse(json);
}
function object(value, name) { if (!value || typeof value !== 'object' || Array.isArray(value)) bad(name + ' must be an object'); }
function allowed(value, keys, name) {
  object(value, name);
  for (const key of Object.keys(value)) if (!keys.includes(key)) bad('Unsupported ' + name + ' field ' + key);
}
function name(v, field) { if (typeof v !== 'string' || !ID.test(v)) bad('Invalid ' + field); return v; }
function list(v, label, max=128) { if (!Array.isArray(v) || v.length > max) bad('Invalid ' + label); return v; }
function rows(v,label) { if (!Array.isArray(v) || v.length > MAX_ROWS) bad('Invalid ' + label + ': 10000 row evaluation limit'); v.forEach((r,i)=>object(r,label+'['+i+']')); return v; }
function hash(domain,value) { return sha256Canonical('assurance:v1:'+domain,value); }
function freeze(v) { if(v&&typeof v==='object') {Object.values(v).forEach(freeze); Object.freeze(v);} return v; }
function ruleValidate(r) {
  allowed(r,['id','type','field','fields','scale','allowed','child','parent','childField','parentField','observationId'],'rule');
  name(r.id,'rule id'); if(!TYPES.has(r.type)) bad('Unsupported covenant rule type');
  for(const k of ['field','child','parent','childField','parentField','observationId']) if(r[k]!==undefined) name(r[k],k);
  if(r.fields!==undefined) {list(r.fields,'fields',8); if(!r.fields.length) bad('Fields cannot be empty'); r.fields.forEach(f=>name(f,'key field'));}
  if(r.type==='field_equal'||r.type==='sum_equal'||r.type==='domain') name(r.field,'rule field');
  if(r.type==='unique' && !r.fields?.length) bad('Unique rule requires key fields');
  if(r.type==='reference_complete') for(const k of ['child','parent','childField','parentField']) name(r[k],k);
  if(r.type==='application_equal') name(r.observationId,'observationId');
  if(r.type==='sum_equal' && (!Number.isInteger(r.scale) || r.scale<0 || r.scale>6)) bad('Exact decimal scale must be 0..6');
  if(r.type==='domain' && (!Array.isArray(r.allowed) || !r.allowed.length || r.allowed.length>64)) bad('Domain needs 1..64 allowed values');
}
export function createCovenant(input) {
  const v=clean(input);
  allowed(v,['id','source','target','keyFields','rules','dependencies','revision'],'covenant');
  name(v.id,'covenant id'); name(v.source,'source category'); name(v.target,'target category');
  if(!Number.isSafeInteger(v.revision)||v.revision<1) bad('Revision must be a positive integer');
  list(v.keyFields,'keyFields',8); if(!v.keyFields.length) bad('Covenant requires explicit identity keys');
  v.keyFields.forEach(f=>name(f,'key field'));
  list(v.rules,'rules',128); if(!v.rules.length) bad('Covenant requires at least one invariant');
  v.rules.forEach(ruleValidate);
  if(new Set(v.rules.map(r=>r.id)).size!==v.rules.length) bad('Rule IDs must be unique');
  v.dependencies=v.dependencies||[];list(v.dependencies,'dependencies',128);
  v.dependencies.forEach(d=>{allowed(d,['id','critical'],'dependency');name(d.id,'dependency');if(typeof d.critical!=='boolean')bad('Dependency critical must be boolean')});
  const digest=hash('covenant',v);
  return freeze({...v,covenantDigest:digest});
}
function encodeKey(row,fields) {
  if(!fields.every(k=>Object.hasOwn(row,k))) return null;
  return canonicalJson(fields.map(k=>row[k]));
}
function indexed(values,fields) {
  const index=new Map();let duplicates=0,missing=0;
  for(const row of values){const k=encodeKey(row,fields);if(k===null){missing++;continue;}if(index.has(k)){duplicates++;continue;}index.set(k,row);}
  return {index,duplicates,missing};
}
export function compareSnapshots({sourceRows,targetRows,keyFields}) {
  const src=rows(clean(sourceRows),'sourceRows'),dst=rows(clean(targetRows),'targetRows');
  list(keyFields,'keyFields',8);if(!keyFields.length)bad('Identity fields required');
  keyFields.forEach(f=>name(f,'keyField'));
  const s=indexed(src,keyFields),t=indexed(dst,keyFields);
  let absent=0,divergent=0,extra=0,matched=0;
  for(const [key,value] of s.index) {
    const other=t.index.get(key);
    if(!other){absent++;continue;}
    if(canonicalJson(value)!==canonicalJson(other)) divergent++; else matched++;
  }
  for(const key of t.index.keys()) if(!s.index.has(key))extra++;
  const indeterminate=s.duplicates+t.duplicates+s.missing+t.missing;
  const status=indeterminate?'INDETERMINATE':absent+divergent+extra?'MISMATCH':'VERIFIED';
  return freeze({status,sourceCount:src.length,targetCount:dst.length,matched,absent,divergent,extra,
    ambiguousSourceKeys:s.duplicates,ambiguousTargetKeys:t.duplicates,missingIdentityKeys:s.missing+t.missing,
    actionsAuthorized:false,containsRawRows:false});
}
function decimal(v,scale) {
  if(typeof v!=='string'||!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(v))bad('Exact decimal requires canonical string, not floating-point input');
  const signum=v.startsWith('-')?-1n:1n, parts=v.replace('-','').split('.');
  if((parts[1]||'').length>scale)bad('Decimal exceeds declared scale; explicit conversion required');
  if(parts[0].length>30)bad('Decimal magnitude exceeds configured bound');
  return signum*BigInt(parts[0]+(parts[1]||'').padEnd(scale,'0'));
}
function observationMap(v) {
  if(v===undefined)return new Map();
  const obs=list(clean(v),'observations',128), map=new Map();
  for(const o of obs){allowed(o,['id','source','target'],'observation');name(o.id,'observation');if(map.has(o.id))bad('Duplicate observation');map.set(o.id,o);}
  return map;
}
export function checkApplicationObservations(observations) {
  const entries=observationMap(observations);let match=0,difference=0,unknown=0;
  for(const o of entries.values()){if(!Object.hasOwn(o,'source')||!Object.hasOwn(o,'target'))unknown++;else if(canonicalJson(o.source)===canonicalJson(o.target))match++;else difference++;}
  return freeze({status:difference?'MISMATCH':unknown?'INDETERMINATE':entries.size?'VERIFIED':'NOT_VERIFIED',match,difference,unknown,
    readOnlyRecordedEvidence:true,liveApplicationExecuted:false});
}
export function evaluateCovenant(covenant,{sourceRows,targetRows,collections={},observations=[]}={}) {
  const c=createCovenant((({covenantDigest,...rest})=>rest)(covenant));
  const source=sourceRows===undefined?null:rows(clean(sourceRows),'sourceRows');
  const target=targetRows===undefined?null:rows(clean(targetRows),'targetRows');
  const tables=clean(collections);object(tables,'collections');
  for(const [key,value] of Object.entries(tables)){name(key,'collection name');rows(value,'collection');}
  const obs=observationMap(observations);const findings=[];
  for(const rule of c.rules){
    let status='NOT_VERIFIED',affected=0,reason='REQUIRED_EVIDENCE_MISSING';
    if(rule.type==='row_count_equal'&&source&&target){affected=Math.abs(source.length-target.length);status=affected?'MISMATCH':'VERIFIED';reason='ROW_COUNT';}
    else if(rule.type==='field_equal'&&source&&target){
      const a=indexed(source,c.keyFields),b=indexed(target,c.keyFields);
      if(a.duplicates||b.duplicates||a.missing||b.missing){status='INDETERMINATE';reason='AMBIGUOUS_IDENTITY';}
      else {
        for(const [key,row] of a.index){const to=b.index.get(key);if(!to||!Object.hasOwn(row,rule.field)||!Object.hasOwn(to,rule.field)||canonicalJson(row[rule.field])!==canonicalJson(to[rule.field]))affected++;}
        status=affected?'MISMATCH':'VERIFIED';reason='FIELD_EQUIVALENCE';
      }
    } else if(rule.type==='sum_equal'&&source&&target){
      try{
        const sum=r=>r.reduce((v,row)=>v+decimal(row[rule.field],rule.scale),0n);
        status=sum(source)===sum(target)?'VERIFIED':'MISMATCH';reason='EXACT_DECIMAL_SUM';affected=status==='MISMATCH'?1:0;
      }catch {status='INDETERMINATE';reason='INVALID_DECIMAL_OR_MISSING_VALUE';}
    } else if(rule.type==='unique'&&target){
      const k=indexed(target,rule.fields);affected=k.duplicates;status=k.missing?'INDETERMINATE':affected?'MISMATCH':'VERIFIED';reason='UNIQUENESS';
    } else if(rule.type==='domain'&&target){
      const allowedValues=new Set(rule.allowed.map(x=>canonicalJson(x)));
      for(const row of target){if(!Object.hasOwn(row,rule.field)||!allowedValues.has(canonicalJson(row[rule.field])))affected++;}
      status=affected?'MISMATCH':'VERIFIED';reason='DECLARED_DOMAIN';
    } else if(rule.type==='reference_complete'&&tables[rule.child]&&tables[rule.parent]){
      const parent=new Set(tables[rule.parent].filter(x=>Object.hasOwn(x,rule.parentField)).map(x=>canonicalJson(x[rule.parentField])));
      for(const row of tables[rule.child])if(!Object.hasOwn(row,rule.childField)||!parent.has(canonicalJson(row[rule.childField])))affected++;
      status=affected?'MISMATCH':'VERIFIED';reason='REFERENTIAL_CLOSURE';
    } else if(rule.type==='application_equal'&&obs.has(rule.observationId)){
      const o=obs.get(rule.observationId);
      status=!Object.hasOwn(o,'source')||!Object.hasOwn(o,'target')?'INDETERMINATE':canonicalJson(o.source)===canonicalJson(o.target)?'VERIFIED':'MISMATCH';
      affected=status==='MISMATCH'?1:0;reason='RECORDED_APPLICATION_OBSERVATION';
    }
    findings.push({id:rule.id,status,affected,reason});
  }
  const resultStatus=findings.some(f=>f.status==='MISMATCH')?'MISMATCH':findings.some(f=>f.status==='INDETERMINATE')?'INDETERMINATE':findings.some(f=>f.status==='NOT_VERIFIED')?'NOT_VERIFIED':'VERIFIED';
  return freeze({schemaVersion:1,covenantDigest:c.covenantDigest,status:resultStatus,findings,checkedRules:findings.length,
    rawRowsIncluded:false,productionAuthorization:false});
}
export function inspectDependencies(declared,observations) {
  const d=list(clean(declared),'declared',256),o=list(clean(observations),'observations',256);
  const seen=new Set(),values=new Map();
  for(const x of d){allowed(x,['id','critical'],'dependency');name(x.id,'dependency');if(typeof x.critical!=='boolean'||seen.has(x.id))bad('Invalid or duplicate dependency');seen.add(x.id);}
  for(const x of o){allowed(x,['id','status'],'dependency observation');name(x.id,'observation');if(!seen.has(x.id)||values.has(x.id)||!STATE.has(x.status))bad('Invalid dependency observation');values.set(x.id,x.status);}
  const blockers=d.filter(x=>x.critical&&values.get(x.id)!=='VERIFIED').map(x=>x.id);
  const unknown=d.filter(x=>!values.has(x.id)).map(x=>x.id);
  return freeze({status:blockers.length?'INDETERMINATE':'VERIFIED',criticalBlockers:blockers,undeclaredCoverageUnknown:true,unobserved:unknown,declaredCount:d.length});
}
export function rescueGraph({sourceRows,targetRows,keyFields}) {
  const c=compareSnapshots({sourceRows,targetRows,keyFields});
  return freeze({status:c.status,counts:{missing:c.absent,divergent:c.divergent,unexpected:c.extra,ambiguous:c.ambiguousSourceKeys+c.ambiguousTargetKeys+c.missingIdentityKeys},
    recommendedAction:c.status==='VERIFIED'?'NO_ACTION':c.status==='INDETERMINATE'?'HALT_AND_INVESTIGATE':'REVIEW_DIFFERENCES_BEFORE_APPROVAL',
    mutations:[],approvalRequired:true,mayAutoReplay:false,sourceOfTruthUnverified:true});
}
export function semanticCompare({kind,source,target,scale,caseSensitive=true}){
  const a=clean(source),b=clean(target);let equal;
  if(kind==='money') {try{equal=decimal(a,scale)===decimal(b,scale)}catch{return freeze({status:'INDETERMINATE',reason:'INVALID_MONEY_FORMAT'});}}
  else if(kind==='text') {if(typeof a!=='string'||typeof b!=='string')return freeze({status:'INDETERMINATE',reason:'INVALID_TEXT'});equal=caseSensitive?a===b:a.toLocaleLowerCase('und')===b.toLocaleLowerCase('und');}
  else if(kind==='identifier') {if(typeof a!=='string'||typeof b!=='string')return freeze({status:'INDETERMINATE',reason:'INVALID_IDENTIFIER'});equal=a===b;}
  else if(kind==='instant') {if(typeof a!=='string'||typeof b!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(a)||!/(Z|[+-]\d\d:\d\d)$/.test(b))return freeze({status:'INDETERMINATE',reason:'OFFSET_REQUIRED'});const x=Date.parse(a),y=Date.parse(b);if(!Number.isFinite(x)||!Number.isFinite(y))return freeze({status:'INDETERMINATE',reason:'INVALID_INSTANT'});equal=x===y;}
  else bad('Unsupported semantic comparison kind');
  return freeze({status:equal?'VERIFIED':'MISMATCH',reason:'DECLARED_'+kind.toUpperCase(),rawValuesIncluded:false});
}
export function diagnoseCompatibility(pack,{target,version,codes}){
  const p=clean(pack);allowed(p,['id','target','version','rules'],'compatibility pack');
  name(p.id,'pack id');name(p.target,'target'); if(typeof p.version!=='string'||!p.version||p.version.length>80)bad('Pack version is required');
  list(p.rules,'compatibility rules',128);const seen=new Set();
  for(const r of p.rules){allowed(r,['id','code','severity','remedy'],'compatibility rule');name(r.id,'rule');name(r.code,'signal');if(seen.has(r.id))bad('Duplicate compatibility rule');seen.add(r.id);if(!['BLOCK','REVIEW'].includes(r.severity)||typeof r.remedy!=='string'||r.remedy.length>300)bad('Invalid compatibility guidance');}
  list(codes,'signal codes',128);codes.forEach(c=>name(c,'signal'));
  if(p.target!==target||p.version!==version)return freeze({status:'INDETERMINATE',reason:'NO_EXACT_VERSION_PACK',matches:[],packDigest:hash('atlas',p)});
  const matches=p.rules.filter(r=>codes.includes(r.code)).map(r=>({id:r.id,severity:r.severity,remedy:r.remedy}));
  return freeze({status:matches.some(r=>r.severity==='BLOCK')?'MISMATCH':matches.length?'INDETERMINATE':'NOT_VERIFIED',matches,packDigest:hash('atlas',p),unmatchedSignals:codes.filter(c=>!p.rules.some(r=>r.code===c))});
}
export function runCounterfactuals(covenant,fixture){
  const c=createCovenant((({covenantDigest,...rest})=>rest)(covenant));
  const f=clean(fixture);allowed(f,['sourceRows','targetRows'],'counterfactual fixture');
  const s=rows(f.sourceRows,'sourceRows'),t=rows(f.targetRows,'targetRows');
  const cases=[['unaltered',t],['target_first_row_removed',t.slice(1)],['target_first_row_modified',t.map((r,i)=>i===0?{...r,__spool_fault:true}:r)],['target_first_row_duplicated',t.length?[...t,t[0]]:t]];
  return freeze({simulationOnly:true,realDatabaseFaultsTested:false,results:cases.map(([scenario,dst])=>({scenario,snapshot:compareSnapshots({sourceRows:s,targetRows:dst,keyFields:c.keyFields}).status}))});
}
export function blindCommitment({key,namespace,value}) {
  if(!Buffer.isBuffer(key)||key.length<32)bad('Blind commitment requires an independently held key of at least 32 bytes');
  name(namespace,'commitment namespace');
  const canonical=canonicalJson(clean(value));
  return freeze({scheme:'HMAC-SHA256:v1',namespace,digest:createHmac('sha256',key).update('SPOOL\0assurance-blind\0'+namespace+'\0'+canonical).digest('hex'),
    rawValueIncluded:false,zeroKnowledgeProof:false,sharedKeyConfidentialityRequired:true});
}
export function evaluateCutover({evaluation,dependencies,executedBy,verifiedBy,approvedBy,rollbackReady,changeWindowApproved}) {
  object(evaluation,'evaluation');object(dependencies,'dependencies');
  for(const [v,n] of [[executedBy,'executedBy'],[verifiedBy,'verifiedBy'],[approvedBy,'approvedBy']])name(v,n);
  const independent=new Set([executedBy,verifiedBy,approvedBy]).size===3;
  const reasons=[];
  if(!independent)reasons.push('SEPARATION_OF_DUTIES');
  if(evaluation.status!=='VERIFIED')reasons.push('COVENANT_UNVERIFIED');
  if(dependencies.status!=='VERIFIED')reasons.push('DEPENDENCIES_UNVERIFIED');
  if(rollbackReady!==true)reasons.push('ROLLBACK_UNVERIFIED');
  if(changeWindowApproved!==true)reasons.push('WINDOW_UNAPPROVED');
  return freeze({decision:reasons.length?'HOLD':'ADVISORY_READY',reasons,mutationsAuthorized:false,identityAuthenticated:false,
    independentlySigned:false,actualCutoverPerformed:false});
}
export function createProofCapsule({covenant,evaluation,dependencies,releaseCommit,observedAt,operator},privateKey){
  const c=createCovenant((({covenantDigest,...rest})=>rest)(covenant));
  const e=clean(evaluation),d=clean(dependencies);
  if(e.covenantDigest!==c.covenantDigest||!STATE.has(e.status)||!Array.isArray(e.findings)||!STATE.has(d.status))bad('Evidence is missing, invalid or bound to another covenant');
  if(typeof releaseCommit!=='string'||!/^[a-f0-9]{40}$/.test(releaseCommit))bad('Exact release commit SHA required');
  name(operator,'operator');
  if(typeof observedAt!=='string'||!Number.isFinite(Date.parse(observedAt))||!observedAt.endsWith('Z'))bad('Explicit UTC timestamp required');
  const payload=freeze({schemaVersion:1,kind:'SPOOL_ASSURANCE_EVIDENCE_PREVIEW',covenantDigest:c.covenantDigest,
    releaseCommit,observedAt,operator,decision:e.status,checks:e.findings.map(x=>({id:name(x.id,'finding id'),status:x.status,affected:x.affected})),
    dependenciesStatus:d.status,rawRowsIncluded:false,authorization:false,claimScope:'RECORDED_EVIDENCE_ONLY'});
  const digest=hash('proof-capsule',payload);
  if(!privateKey)return freeze({payload,digest,signature:null,signatureStatus:'UNSIGNED'});
  const publicKey=createPublicKey(privateKey),keyId=createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex');
  const signature=sign(null,Buffer.from(digest,'utf8'),privateKey).toString('base64');
  return freeze({payload,digest,signature:{algorithm:'Ed25519',keyId,bytes:signature},signatureStatus:'SIGNED'});
}
export function verifyProofCapsule(capsule,publicKey){
  const c=clean(capsule);
  allowed(c,['payload','digest','signature','signatureStatus'],'proof capsule');
  if(hash('proof-capsule',c.payload)!==c.digest)return freeze({verified:false,reason:'PAYLOAD_TAMPERED'});
  if(!c.signature||c.signatureStatus!=='SIGNED')return freeze({verified:false,reason:'UNSIGNED'});
  if(!publicKey)return freeze({verified:false,reason:'NO_TRUST_ROOT'});
  const spki=createPublicKey(publicKey).export({type:'spki',format:'der'});
  const id=createHash('sha256').update(spki).digest('hex');
  if(id!==c.signature.keyId||c.signature.algorithm!=='Ed25519')return freeze({verified:false,reason:'WRONG_TRUST_ROOT'});
  let valid=false;try {valid=verify(null,Buffer.from(c.digest,'utf8'),publicKey,Buffer.from(c.signature.bytes,'base64'));} catch {valid=false;}
  return freeze({verified:valid,reason:valid?'SIGNED_EVIDENCE_ONLY':'BAD_SIGNATURE',productionAuthorization:false});
}
