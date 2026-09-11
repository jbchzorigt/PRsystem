const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');
 await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})}).catch(e=>{server.close();throw e;});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),origin=`http://127.0.0.1:${server.address().port}`,requests=[],errors=[],receipts=new Map();
  let role='CLEANER',prepared=false,done=false,loadFail=true,countLost=true,applyLost=true;
  const room={room_id:'101',number:'101',category_id:'standard',category_name:'Стандарт',category_status:'ACTIVE',status:'ACTIVE',cleaning_state:'CLEAN',minibar_mode:'OFF',revision:1,pending_minibar_change:true};
  const req={request_id:'config-1',revision:1,state:'READY_FOR_RECONCILIATION',request_kind:'NEXT_STAY',target_mode:'ON',reason:'Шинэ бүрдэл',recorded_at:'2026-09-09T01:00:00Z',target_snapshot:{template_name:'Стандарт',version_number:1,items:[{product_id:'water',name:'Ус',unit:'ш',target_quantity:2},{product_id:'juice',name:'Жүүс',unit:'ш',target_quantity:1}]}};
  const lines=req.target_snapshot.items.map(i=>({...i,baseline_quantity:0,actual_count:null,warehouse_quantity:10,quantity:i.target_quantity,direction:'REFILL',shortage:0,action_id:i.product_id}));
  const plan=()=>({lines,counts_complete:lines.every(i=>i.actual_count!==null),counts_match:lines.every(i=>i.actual_count===0),shortage:false});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/auth/**',r=>r.fulfill({json:new URL(r.request().url()).pathname==='/auth/login'?{access_token:'fake-token'}:{roles:[role]}}));
  await page.route('**/hotels/**',async r=>{
   const u=new URL(r.request().url()),tail=u.pathname.replace('/hotels/test-hotel/',''),body=r.request().postDataJSON(),method=r.request().method();
   if(body)requests.push({tail,body,method});let result={};
   if(body&&receipts.has(body.idempotency_key)){await r.fulfill({json:receipts.get(body.idempotency_key)});return;}
   if(tail==='operations')result={roles:[role],package_mnt:30000,mode:'LIVE',staff:[{account_id:'cleaner',email:'cleaner@example.com',roles:['CLEANER']}],funding:[],cleaning:[],inspections:[],limit:100};
   else if(tail==='rooms')result=[room];
   else if(['room-categories','stays/active','bookings','cleaning/checkouts'].includes(tail))result=[];
   else if(tail==='rooms/101/minibar-configuration')result={room_number:'101',current:{mode:room.minibar_mode,room_revision:room.revision},pending:done?null:req,items:[req],next_after:null};
   else if(tail==='minibar/reconciliation/tasks/task/claim-next-stay'){assert.equal(role,'CLEANER');assert.equal(body.expected_revision,req.revision);prepared=true;req.revision++;req.state='IN_PROGRESS';result={task_id:'task',assignment_version:0,revision:req.revision,state:req.state};}
   else if(tail==='minibar/reconciliation/tasks'){
    assert.equal(role,'CLEANER');if(loadFail){loadFail=false;await r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});return;}
    result={items:!done?[{task_id:'task',assignment_version:0,room_number:'101',work_state:prepared?'OPEN':null,claimable:!prepared,request:req,plan:plan()}]:[],next_after:null};
   }else if(tail==='minibar/reconciliation/tasks/task/count'){
    assert.equal(role,'CLEANER');assert.equal(body.assignment_version,0);const line=lines.find(i=>i.action_id===body.action_id);assert.equal(line.actual_count,null);line.actual_count=body.actual_count;req.revision++;result={request_id:req.request_id,revision:req.revision,state:'IN_PROGRESS'};receipts.set(body.idempotency_key,result);
    if(countLost){countLost=false;await r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});return;}
   }else if(tail==='minibar/reconciliation/tasks/task/apply'){
    assert.equal(role,'CLEANER');assert.equal(body.expected_revision,req.revision);assert.equal(body.physical_transfers_confirmed,true);assert(plan().counts_match);done=true;req.state='APPLIED';req.revision++;room.minibar_mode='ON';room.pending_minibar_change=false;result={request_id:req.request_id,revision:req.revision,state:'APPLIED'};receipts.set(body.idempotency_key,result);
    if(applyLost){applyLost=false;await r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});return;}
   }else throw Error('Unexpected request: '+tail);
   if(body)receipts.set(body.idempotency_key,structuredClone(result));await r.fulfill({json:result});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false'&&!document.querySelector('form[aria-busy="true"]'));
  const login=async view=>{await page.goto('about:blank');await page.goto(origin+'/reception#'+view);await page.getByLabel('Буудлын код').fill('test-hotel');await page.getByLabel('Имэйл',{exact:true}).fill('staff@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await ready();};
  await login('cleaning');await page.getByRole('button',{name:'Минибарын тохиргооны ажлууд',exact:true}).click();await page.getByRole('button',{name:'Тохиргооны ажлыг дахин ачаалах',exact:true}).click();await page.getByRole('button',{name:'Бэлтгэх ажлыг өөртөө авах',exact:true}).click();await ready();assert(prepared);
  let f=page.locator('form').filter({has:page.getByRole('heading',{name:'Ус тоолох',exact:true})});await f.getByRole('button',{name:'Тооллогыг батлах',exact:true}).click();assert.equal(await page.evaluate(()=>document.activeElement.name),'actual_count');await f.getByLabel('Өрөөнд бодитоор байгаа тоо').fill('0');await f.getByRole('button',{name:'Тооллогыг батлах',exact:true}).click();await f.locator('.result.error').waitFor();await f.getByRole('button',{name:'Тооллогыг батлах',exact:true}).click();await ready();
  f=page.locator('form').filter({has:page.getByRole('heading',{name:'Жүүс тоолох',exact:true})});await f.getByLabel('Өрөөнд бодитоор байгаа тоо').fill('0');await f.getByRole('button',{name:'Тооллогыг батлах',exact:true}).click();await ready();await page.getByRole('button',{name:'Шилжүүлэлт, тохиргоог батлах',exact:true}).waitFor();
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/minibar-next-stay-desktop.png',fullPage:true});await page.setViewportSize({width:320,height:760});await page.emulateMedia({reducedMotion:'reduce'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'artifacts/minibar-next-stay-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'Шилжүүлэлт, тохиргоог батлах',exact:true}).click();assert.equal(await page.evaluate(()=>document.activeElement.name),'physical_transfers_confirmed');await page.getByLabel('Дээрх бүх шилжүүлэлтийг биечлэн гүйцэтгэсэн').check();await page.getByRole('button',{name:'Шилжүүлэлт, тохиргоог батлах',exact:true}).click();await page.locator('.result.error').waitFor();await page.getByRole('button',{name:'Шилжүүлэлт, тохиргоог батлах',exact:true}).click();await ready();await page.getByText('Өөрт тань оноосон тохиргооны ажил алга.',{exact:true}).waitFor();
  assert.equal(room.minibar_mode,'ON');assert.equal(room.cleaning_state,'CLEAN');for(const suffix of ['count','apply']){const calls=requests.filter(x=>x.tail.endsWith('/'+suffix));assert.equal(calls[0].body.idempotency_key,calls[1].body.idempotency_key);}
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.deepEqual(errors,[]);fs.writeFileSync('artifacts/minibar-next-stay-requests.json',JSON.stringify(requests));
  console.log('Automatic next-stay minibar browser: Cleaner claim, physical counts, atomic apply, lost-response retries, validation, load recovery and mobile passed.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
