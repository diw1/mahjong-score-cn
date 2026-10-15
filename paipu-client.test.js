'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const Client=require('./paipu-client.js');
const fixture=JSON.parse(fs.readFileSync(__dirname+'/client-synthetic-fixtures.json','utf8'));
const binary=value=>new Uint8Array(Buffer.from(value,'base64'));
const expectedPoints=[24200,8700,49400,17700];
function inspect(record){
  assert.deepEqual(record.players.map(p=>p.name),['Test 0','Test 1','Test 2','Test 3']);
  assert.deepEqual(record.result.map(p=>p.points),expectedPoints);
  assert.deepEqual(record.result.map(p=>p.officialPT),[-0.8,-16.3,24.4,-7.3]);
  assert.deepEqual(record.rounds.map(r=>[r.winner,r.from,r.zimo,r.aka,r.ura,r.ippatsu]),[[2,1,false,1,0,false],[0,null,true,0,0,true],[2,null,true,2,0,false]]);
}
for(const version of ['old','actions']){
  for(const kind of ['response','frame']) test('compiler fixture '+version+' '+kind,()=>inspect(Client.parseRecord(binary(fixture[version][kind]))));
  for(const kind of ['wrapper','detail']) test('compiler fixture '+version+' '+kind+' with metadata',()=>inspect(Client.parseRecord(binary(fixture[version][kind]),{head:fixture.head})));
  test('compiler JSON fixture '+version,()=>inspect(Client.parseRecord(JSON.stringify(fixture[version].json))));
}
test('signed int32 raw points stay separate from official final PT',()=>{
  const record=Client.parseRecord(fixture.negative);
  assert.deepEqual(record.result.map(p=>p.points),[-1000,51000,30000,20000]);
  assert.deepEqual(record.result.map(p=>p.officialPT),[-0.8,-16.3,24.4,-7.3]);
});

test('official final PT comes only from total_point in thousandths, with snake and camel JSON names',()=>{
  const source=structuredClone(fixture.old.json),totals=[-31500,-15123,52250,-5627];
  source.head.result.players.forEach((p,i)=>p.total_point=totals[i]);
  delete source.head.result.players[2].total_point;source.head.result.players[2].totalPoint=totals[2];
  const record=Client.parseRecord(source);
  assert.deepEqual(record.result.map(p=>p.officialPT),[-31.5,-15.123,52.25,-5.627]);
  assert.deepEqual(record.result.map(p=>p.points),expectedPoints);
  assert.notEqual(record.result[0].officialPT,(expectedPoints[0]-25000)/1000);
});

test('JSON absent official metadata and old normalized files stay unknown while explicit zero stays zero',()=>{
  const source=structuredClone(fixture.old.json);
  source.head.result.players.forEach(p=>delete p.total_point);
  source.head.result.players[1].total_point=0;
  const record=Client.parseRecord(source);
  assert.equal(Object.hasOwn(record.result[0],'officialPT'),false);
  assert.equal(Object.hasOwn(record.result[1],'officialPT'),true);assert.equal(record.result[1].officialPT,0);
  record.result.forEach(p=>delete p.officialPT);
  for(const copy of [Client.validateRecord(record),Client.parseRecord(JSON.stringify(record))])assert.ok(copy.result.every(p=>!Object.hasOwn(p,'officialPT')));
});

test('explicit metadata result keeps official PT without reconstructing it from point totals',()=>{
  const sourceHead=structuredClone(fixture.head);delete sourceHead.result;
  const result=expectedPoints.map((points,seat)=>({seat,points,officialPT:[0,-3.001,3.001,0][seat]}));
  assert.deepEqual(Client.parseRecord(binary(fixture.old.wrapper),{head:sourceHead,result}).result,result);
});

test('official PT must be a finite numeric signed-int32 thousandth and is never coerced',()=>{
  for(const value of [null,'0',false,{},NaN,Infinity,-Infinity,0.0001,2147483.648,-2147483.649]){
    const record=Client.parseRecord(fixture.old.json);record.result[0].officialPT=value;
    assert.throws(()=>Client.validateRecord(record),e=>e.code==='INVALID_RECORD');
  }
  for(const value of [null,'0',false,{},1.5,2147483648,-2147483649]){
    const source=structuredClone(fixture.old.json);source.head.result.players[0].total_point=value;
    assert.throws(()=>Client.parseRecord(source),e=>e.code==='INVALID_RECORD');
  }
  for(const value of [0,0.001,-0.001,1.001,2147483.647,-2147483.648]){
    const record=Client.parseRecord(fixture.old.json);record.result[0].officialPT=value;
    assert.equal(Client.validateRecord(record).result[0].officialPT,value);
  }
});
test('permission errors cannot yield a record',()=>{
  assert.throws(()=>Client.parseRecord(binary(fixture.notLoginFrame)),e=>e.code==='ERR_NOT_LOGIN'&&e.details.serverCode===1004);
  assert.throws(()=>Client.parseRecord({error:{code:1004}}),e=>e.code==='ERR_NOT_LOGIN');
});
test('normalized imports validate and return a clean independent copy',()=>{
  const source=Client.parseRecord(fixture.old.json),copy=Client.validateRecord(source);
  assert.deepEqual(copy,source);assert.notEqual(copy.players,source.players);
  source.result[0].points++;assert.throws(()=>Client.validateRecord(source),/总和/);
});
test('payer and unknown special rules never silently invent payments',()=>{
  const event={name:'.lq.RecordHule',data:{hules:[{seat:2,fans:[{id:33,val:2}]}]}};
  assert.throws(()=>Client.parseRecord({records:[{name:'.lq.RecordNewRound',data:{scores:[25000,25000,25000,25000]}},event]},{head:fixture.head}),/放铳者/);
  for(const name of ['.lq.RecordHuleXueZhanEnd','.lq.RecordHuleXueZhanMid','.lq.RecordHulesInfo'])assert.throws(()=>Client.parseRecord({records:[{name,data:{}}]},{head:fixture.head}),e=>e.code==='UNSUPPORTED_MODE');
  assert.throws(()=>Client.parseRecord({records:[]},{head:fixture.head}),e=>e.code==='UNSUPPORTED_RECORD_VERSION');
});
test('ura identifier 33 is counted and ankan robbery pays the last actor',()=>{
  const record=Client.parseRecord({records:[{name:'.lq.RecordNewRound',data:{scores:[25000,25000,25000,25000]}},{name:'.lq.RecordAnGangAddGang',data:{seat:3}},{name:'.lq.RecordHule',data:{scores:expectedPoints,hules:[{seat:1,fans:[{id:33,val:2}]}]}}]},{head:fixture.head});
  assert.equal(record.rounds[0].ura,2);assert.equal(record.rounds[0].from,3);
});
test('malformed protobuf fails clearly',()=>{
  for(const data of [new Uint8Array([0]),new Uint8Array([10,255]),new Uint8Array([15]),new Uint8Array([128,128])])assert.throws(()=>Client.parseRecord(data),e=>e.code==='INVALID_RECORD');
});
test('configured loader uses only link metadata and local decoding',async()=>{
  const link='https://mahjongsoul.game.yo-star.com/?paipu=261014-00000000-0000-0000-0000-000000000000_a1';
  let called=0;
  inspect(await Client.fetchRecord(link,{loader:async(meta,options)=>{called++;assert.equal(meta.id,'261014-00000000-0000-0000-0000-000000000000');assert.equal(typeof options.onProgress,'function');const data=structuredClone(fixture.actions.json);data.head.uuid=meta.id;return data;}}));
  assert.equal(called,1);
  await assert.rejects(Client.fetchRecord(link,{signal:AbortSignal.abort(),loader:async()=>fixture.old.json}),e=>e.code==='ABORTED');
  await assert.rejects(Client.fetchRecord('https://game.maj-soul.com/1/?paipu=x'),e=>e.code==='UNSUPPORTED_REGION');
});
test('anonymous bot IDs are scoped to each replay instead of merging across files',()=>{
  const first=structuredClone(fixture.old.json),second=structuredClone(fixture.old.json);
  first.head.uuid='bot-replay-1';second.head.uuid='bot-replay-2';
  first.head.accounts.forEach(p=>p.account_id=0);second.head.accounts.forEach(p=>p.account_id=0);
  assert.equal(Client.parseRecord(first).players[0].id,'bot-replay-1:seat-0');
  assert.equal(Client.parseRecord(second).players[0].id,'bot-replay-2:seat-0');
});
test('the most recent win cannot stand in for a later terminal draw result',()=>{
  const noResultHead=structuredClone(fixture.head);delete noResultHead.result;
  assert.throws(()=>Client.parseRecord(binary(fixture.old.wrapper),{head:noResultHead}),e=>e.code==='RECORD_METADATA_REQUIRED');
  const explicit=Client.parseRecord(binary(fixture.old.wrapper),{head:noResultHead,result:expectedPoints.map((points,seat)=>({seat,points}))});
  assert.deepEqual(explicit.result.map(p=>p.points),expectedPoints);
});
test('truncated raw data cannot be mislabeled as a complete zero-chip game',()=>{
  for(const records of [[{name:'.lq.RecordNewRound',data:{scores:[25000,25000,25000,25000]}}],[{name:'.lq.UnknownEvent',data:{}}]])
    assert.throws(()=>Client.parseRecord({records},{head:fixture.head}),e=>e.code==='TRUNCATED_RECORD');
  const mismatched=structuredClone(fixture.old.json);mismatched.head.result.players[0].part_point_1++;
  assert.throws(()=>Client.parseRecord(mismatched),/不一致/);
});
test('a complete all-draw record has zero winning events and uses authoritative final points',()=>{
  const drawHead=structuredClone(fixture.head),points=[24000,24000,28000,24000];drawHead.result.players.forEach(p=>p.part_point_1=points[p.seat||0]);
  const records=[{name:'.lq.RecordNewRound',data:{scores:[25000,25000,25000,25000]}},{name:'.lq.RecordNoTile',data:{scores:[{old_scores:[25000,25000,25000,25000],delta_scores:[-1000,-1000,3000,-1000]}]}}];
  const record=Client.parseRecord({records},{head:drawHead});
  assert.deepEqual(record.rounds,[]);assert.deepEqual(record.result.map(p=>p.points),points);
  drawHead.result.players[0].part_point_1++;
  assert.throws(()=>Client.parseRecord({records},{head:drawHead}),/不一致/);
});
test('named red dragon yaku is not mistaken for an aka-dora bonus',()=>{
  const records=[{name:'.lq.RecordNewRound',data:{scores:[25000,25000,25000,25000]}},{name:'.lq.RecordHule',data:{scores:expectedPoints,hules:[{seat:0,zimo:true,fans:[{name:'红中',val:1},{name:'赤ドラ',val:2}]}]}}];
  assert.equal(Client.parseRecord({records},{head:fixture.head}).rounds[0].aka,2);
});

test('copied share text is accepted while mismatched records are rejected',async()=>{
  const url='https://mahjongsoul.game.yo-star.com/?paipu=260101-11111111-1111-4111-8111-111111111111_a12345678';
  const copied='雀魂牌譜:'+url+'\u00a0';
  const record=await Client.fetchRecord(copied,{loader:async meta=>{
    assert.equal(meta.url,url);const data=structuredClone(fixture.old.json);data.head.uuid=meta.id;return data;
  }});
  assert.equal(record.id,'260101-11111111-1111-4111-8111-111111111111');
  await assert.rejects(Client.fetchRecord(url,{loader:async()=>fixture.old.json}),error=>error.code==='RECORD_MISMATCH');
  await assert.rejects(Client.fetchRecord(url.replace('https://','https://private:secret@'),{loader:async()=>fixture.old.json}),error=>error.code==='INVALID_RECORD');
});

function parseWin(hule){
  return Client.parseRecord({records:[
    {name:'.lq.RecordNewRound',data:{scores:[25000,25000,25000,25000]}},
    {name:'.lq.RecordHule',data:{scores:expectedPoints,hules:[{seat:0,zimo:true,...hule}]}}
  ]},{head:fixture.head}).rounds[0];
}
test('true yakuman IDs and fan values preserve single, double, and compound units',()=>{
  assert.equal(parseWin({yiman:true,count:1,fans:[{id:37,val:1}]}).yakumanUnits,1);
  for(const id of [47,48,49,50])assert.equal(parseWin({yiman:true,count:2,fans:[{id,val:2}]}).yakumanUnits,2);
  assert.equal(parseWin({yiman:true,count:3,fans:[{id:50,val:2},{id:39,val:1}]}).yakumanUnits,3);
  assert.equal(parseWin({yiman:true,count:2,fans:[{id:38,val:1},{id:37,val:1}]}).yakumanUnits,2);
  // A rule may disable the double multiplier; use the actual value, not just its ID.
  assert.equal(parseWin({yiman:true,count:1,fans:[{id:47,val:1}]}).yakumanUnits,1);
  assert.equal(parseWin({fans:[{id:37,val:1}]}).yakumanUnits,1);
});
test('kazoe and ordinary high-han hands never become true yakuman',()=>{
  const fans=[{id:1,val:1},{id:29,val:6},{id:31,val:6}];
  assert.equal(parseWin({yiman:false,count:13,title_id:11,fans}).yakumanUnits,0);
  assert.equal(parseWin({count:26,title:'累计役满',fans}).yakumanUnits,0);
  assert.equal(parseWin({yiman:false,count:5,fans:[{id:59,val:5}]}).yakumanUnits,0);
});
test('missing or conflicting yakuman metadata never guesses a multiplier',()=>{
  for(const hule of [{yiman:true,count:1},{yiman:true,count:2,fans:[]}])assert.throws(()=>parseWin(hule),e=>e.code==='YAKUMAN_METADATA_REQUIRED');
  assert.throws(()=>parseWin({yiman:true,fans:[{id:999,val:1}]}),e=>e.code==='YAKUMAN_METADATA_REQUIRED');
  for(const hule of [
    {yiman:true,count:2,fans:[{id:47,val:1}]},
    {yiman:true,count:1.5,fans:[{id:37,val:1}]},
    {yiman:true,count:1,fans:[{id:37,val:0}]}
  ])assert.throws(()=>parseWin(hule),e=>e.code==='INVALID_RECORD');
});
test('new raw wins explicitly carry zero; old normalized wins retain unknown metadata',()=>{
  const record=Client.parseRecord(fixture.old.json);
  assert.ok(record.rounds.every(r=>r.yakumanUnits===0));
  record.rounds.forEach(r=>delete r.yakumanUnits);
  assert.ok(Client.validateRecord(record).rounds.every(r=>!Object.hasOwn(r,'yakumanUnits')));
  for(const value of [-1,1.5,'2',null,101]){
    const bad=structuredClone(record);bad.rounds[0].yakumanUnits=value;
    assert.throws(()=>Client.validateRecord(bad),e=>e.code==='INVALID_RECORD');
  }
});
function vint(n){const out=[];let value=BigInt(n);do{let b=Number(value&127n);value>>=7n;if(value)b|=128;out.push(b);}while(value);return out;}
function pv(id,n){return [...vint(id*8),...vint(n)];}
function pb(id,value){const b=typeof value==='string'?Buffer.from(value):value;return [...vint(id*8+2),...vint(b.length),...b];}
function responseWithOfficialTotals(totals,omitZeros=false){
  const signed=(id,n)=>pv(id,BigInt.asUintN(64,BigInt(n)));
  const players=totals.flatMap((n,seat)=>pb(1,[...pv(1,seat),...(omitZeros&&n===0?[]:signed(2,n)),...signed(3,expectedPoints[seat])]));
  const accounts=[0,1,2,3].flatMap(seat=>pb(11,[...pv(1,100+seat),...pv(2,seat),...pb(3,'Test '+seat)]));
  const head=[...pb(1,'synthetic-only'),...accounts,...pb(12,players)];
  return Uint8Array.from([...pb(3,head),...pb(4,binary(fixture.old.detail))]);
}
test('binary total_point field 2 preserves signed thousandths and proto3 omitted zero',()=>{
  const totals=[0,-15123,20750,-5627];
  for(const omitZeros of [false,true]){
    const record=Client.parseRecord(responseWithOfficialTotals(totals,omitZeros));
    assert.deepEqual(record.result.map(p=>p.officialPT),[0,-15.123,20.75,-5.627]);
    assert.deepEqual(record.result.map(p=>p.points),expectedPoints);
  }
});
function winBinary(yiman,count,fans){
  const hule=[...pv(5,1),...pv(10,yiman?1:0),...pv(11,count),...fans.flatMap(f=>pb(12,[...pv(2,f.val),...pv(3,f.id)]))];
  const newRound=pb(2,pb(5,[25000,25000,25000,25000].flatMap(vint)));
  const opening=[...pb(1,'.lq.RecordNewRound'),...newRound];
  const closing=[...pb(1,'.lq.RecordHule'),...pb(2,[...pb(1,hule),...pb(5,expectedPoints.flatMap(vint))])];
  return Uint8Array.from([...pb(1,opening),...pb(1,closing)]);
}
test('binary HuleInfo fields 10 and 11 distinguish true multipliers from kazoe han',()=>{
  for(const [flag,count,fans,want] of [
    [true,2,[{id:48,val:2}],2],
    [true,3,[{id:50,val:2},{id:39,val:1}],3],
    [false,13,[{id:29,val:6},{id:31,val:7}],0]
  ])assert.equal(Client.parseRecord(winBinary(flag,count,fans),{head:fixture.head}).rounds[0].yakumanUnits,want);
});
