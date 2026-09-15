const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');
 await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})}).catch(e=>{server.close();throw e;});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),origin=`http://127.0.0.1:${server.address().port}`,requests=[],errors=[],receipts=new Map();
  const lost=new Set();
  let role='CLEANER',prepared=true,done=false,loadFail=false,countLost=false,applyLost=false;
  const room={room_id:'101',number:'101',category_id:'standard',category_name:'Стандарт',category_status:'ACTIVE',status:'ACTIVE',cleaning_state:'CLEAN',minibar_mode:'OFF',revision:1,pending_minibar_change:true};
  const req={request_id:'config-1',revision:1,state:'READY_FOR_RECONCILIATION',target_mode:'ON',reason:'Шинэ бүрдэл',recorded_at:'2026-09-09T01:00:00Z',target_snapshot:{template_name:'Стандарт',version_number:1,items:[{product_id:'water',name:'Ус',unit:'ш',target_quantity:2},{product_id:'juice',name:'Жүүс',unit:'ш',target_quantity:1}]}};
  const lines=req.target_snapshot.items.map(i=>({...i,baseline_quantity:0,actual_count:0,current_quantity:0,stock_revision:1,warehouse_quantity:10,quantity:i.target_quantity,direction:'REFILL',shortage:0,action_id:i.product_id}));
  const plan=()=>({lines,rollback:req.state==='ROLLBACK_REQUIRED',ready_to_complete:lines.every(i=>!i.quantity),counts_complete:true,counts_match:true,shortage:false});
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
   else if(tail==='minibar/configuration-requests/config-1/prepare'){assert.equal(role,'MANAGER');assert.equal(body.expected_revision,req.revision);assert.equal(body.assignee_id,'cleaner');prepared=true;req.revision++;req.state='IN_PROGRESS';result={request_id:req.request_id,task_id:'task',assignment_version:0,revision:req.revision,state:req.state};}
   else if(tail==='minibar/reconciliation/tasks'){
    assert.equal(role,'CLEANER');if(loadFail){loadFail=false;await r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});return;}
    result={items:prepared&&!done?[{task_id:'task',assignment_version:0,room_number:'101',work_state:'OPEN',request:req,plan:plan()}]:[],next_after:null};
   }else if(tail==='minibar/reconciliation/tasks/task/transfer'||tail==='minibar/reconciliation/tasks/task/rollback-transfer'){
    assert.equal(body.expected_revision,req.revision);assert.equal(body.expected_stock_revision,1);assert.equal(body.physical_transfers_confirmed,true);
    const line=lines.find(i=>i.product_id===body.product_id),rollback=tail.endsWith('rollback-transfer');
    if(rollback)assert.equal(body.actual_count,line.current_quantity);
    line.current_quantity+=rollback?-body.quantity:body.quantity;line.warehouse_quantity+=rollback?body.quantity:-body.quantity;
    line.quantity=Math.abs(line.target_quantity-line.current_quantity);line.direction=rollback?'RETURN':'REFILL';req.revision++;result={state:req.state,revision:req.revision};
    receipts.set(body.idempotency_key,structuredClone(result));if(!lost.has(tail)){lost.add(tail);await r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});return;}
   }else if(tail==='minibar/reconciliation/tasks/task/complete-rollback'){
    assert.equal(body.expected_revision,req.revision);assert.deepEqual(body.observed_counts,{water:0,juice:0});assert.equal(body.physical_transfers_confirmed,true);
    req.state='ROLLED_BACK';req.revision++;done=true;result={state:req.state,revision:req.revision};
   }else throw Error('Unexpected request: '+tail);
   if(body)receipts.set(body.idempotency_key,structuredClone(result));await r.fulfill({json:result});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false'&&!document.querySelector('form[aria-busy="true"]'));
  const login=async view=>{await page.goto('about:blank');await page.goto(origin+'/reception#'+view);await page.getByLabel('Буудлын код').fill('test-hotel');await page.getByLabel('Имэйл',{exact:true}).fill('staff@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await ready();};
  await login('cleaning');await page.getByRole('button',{name:'Минибарын тохиргооны ажлууд',exact:true}).click();
  let f=page.locator('form').filter({has:page.getByRole('heading',{name:'Ус · Хэсэгчлэн шилжүүлэх',exact:true})});
  await f.getByLabel('Биечлэн шилжүүлсэн тоо').fill('1');await f.getByLabel('Энэ шилжүүлэлтийг биечлэн гүйцэтгэсэн').check();await f.getByRole('button',{name:'Хэсэгчилсэн хөдөлгөөн бүртгэх',exact:true}).click();await f.locator('.result.error').waitFor();await f.getByRole('button',{name:'Хэсэгчилсэн хөдөлгөөн бүртгэх',exact:true}).click();await ready();
  assert.equal(lines[0].current_quantity,1);assert.equal(room.minibar_mode,'OFF');
  req.state='ROLLBACK_REQUIRED';req.revision++;for(const line of lines){line.target_quantity=0;line.quantity=line.current_quantity;line.direction='RETURN';}
  await page.getByRole('button',{name:'Тохиргооны ажлуудыг шинэчлэх',exact:true}).click();await ready();
  assert.equal(await page.getByRole('button',{name:'Шилжүүлэлт, тохиргоог батлах',exact:true}).count(),0);
  f=page.locator('form').filter({has:page.getByRole('heading',{name:'Ус · Агуулахад буцаах',exact:true})});
  await f.getByLabel('Шилжүүлэхийн өмнөх бодит тоо').fill('1');await f.getByLabel('Биечлэн шилжүүлсэн тоо').fill('1');await f.getByLabel('Шилжүүлэлтийг биечлэн гүйцэтгэсэн').check();await f.getByRole('button',{name:'Буцаалтын хөдөлгөөн бүртгэх',exact:true}).click();await f.locator('.result.error').waitFor();await f.getByRole('button',{name:'Буцаалтын хөдөлгөөн бүртгэх',exact:true}).click();await ready();
  fs.mkdirSync('artifacts',{recursive:true});await page.setViewportSize({width:320,height:760});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'artifacts/minibar-partial-mobile.png',fullPage:true});
  f=page.locator('form').filter({has:page.getByRole('heading',{name:'Буцаалтын эцсийн тооллого',exact:true})});await f.getByLabel('Ус · Бодит тоо').fill('0');await f.getByLabel('Жүүс · Бодит тоо').fill('0');await f.getByLabel('Анхны үлдэгдлийг биечлэн сэргээсэн').check();await f.getByRole('button',{name:'Буцаалтыг дуусгах',exact:true}).click();await ready();
  await page.getByText('Өөрт тань оноосон тохиргооны ажил алга.',{exact:true}).waitFor();assert.equal(req.state,'ROLLED_BACK');assert.equal(room.cleaning_state,'CLEAN');assert.equal(lines[0].warehouse_quantity,10);
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.deepEqual(errors,[]);fs.writeFileSync('artifacts/minibar-partial-requests.json',JSON.stringify(requests));
  console.log('Minibar partial browser: bounded movement, compensating rollback, observed final counts, mobile and realm actions passed.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
