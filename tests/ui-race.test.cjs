const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('取消后新任务不受旧步骤响应、finally 和轮询影响', async () => {
  const nodes = new Map(), steps = [], sleeps = [], calls = [];
  const element = () => ({value:'', hidden:false, disabled:false, textContent:'', innerHTML:'', className:'', appendChild(){}, addEventListener(){}});
  const node = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const old = {id:'old', model:'m', status:'pending', queries:[{status:'pending', expected_count:300, attempts:[]}]};
  const cancelled = {...old,status:'cancelled'};
  const fresh = {...old,id:'new'};
  const reply = data => ({status:200,body:new TextEncoder().encode(JSON.stringify(data)).buffer});
  const bridge = {request: async input => {
    calls.push(input);
    if(input.path==='run/step') return new Promise(resolve => steps.push(resolve));
    if(input.path==='run/cancel') return reply({run:cancelled});
    if(input.path==='run') return reply({run:fresh});
    if(input.path==='runs' && input.method==='POST') return reply({run:fresh});
    if(input.path==='runs') return reply({runs:[]});
    throw Error(input.path);
  }};
  const context = vm.createContext({
    window:{codexProxyPlugin:bridge,MODEL_TRACE_BANK:{models:[{}]},ModelTrace:{generateChallenges:()=>[{prompt:'test',expected_count:300}]}},
    document:{getElementById:node,createElement:element,addEventListener(){}},
    TextDecoder,TextEncoder,ArrayBuffer,console,
    setTimeout(fn,ms){ if(ms===4000 && fn.name==='') sleeps.push(fn); return 1; }, clearTimeout(){},
  });
  const source = fs.readFileSync(path.join(__dirname,'../ui/app.js'),'utf8')
    .replace(/\}\)\(\);\s*$/, 'window.test={state,drive,cancelRun,startRun};})();');
  vm.runInContext(source,context);
  const t=context.window.test;
  const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
  t.state.run=old;t.state.busy=true;
  const oldDrive=t.drive();await flush();
  await t.cancelRun();
  assert.equal(t.state.busy,false);
  node('f-key').value='test-key';node('f-model').value='m';
  await t.startRun();await flush();
  assert.equal(t.state.run.id,'new');
  assert.equal(steps.length,2);
  steps[0](reply({run:cancelled}));await flush();
  assert.equal(t.state.run.id,'new');
  assert.equal(t.state.stepInFlight,true);
  const pollsBefore=calls.filter(x=>x.path==='run').length;
  sleeps.shift()();await oldDrive;
  assert.equal(calls.filter(x=>x.path==='run').length,pollsBefore);
  assert.equal(t.state.busy,true);
});
