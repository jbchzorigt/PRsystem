const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');
 await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})}).catch(e=>{server.close();throw e;});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),origin=`http://127.0.0.1:${server.address().port}`,requests=[],errors=[],receipts=new Map();
  let role='CLEANER',actual=null,approved=false,stale=false,done=false,loadFail=true,conflict=true,approvalLost=true,applyLost=true;
  const room={room_id:'101',number:'101',category_id:'standard',category_name:'Стандарт',category_status:'ACTIVE',status:'ACTIVE',cleaning_state:'CLEAN',minibar_mode:'ON',revision:4,pending_minibar_change:true};
  const target={template_name:'Стандарт',version_number:2,items:[{product_id:'water',name:'Ус',unit:'ш',target_quantity:2}]};
  const req={request_id:'config',room_id:'101',revision:2,state:'IN_PROGRESS',target_mode:'ON',reason:'Бүрдлийг шалгах',recorded_at:'2026-09-14T01:00:00Z',target_snapshot:target};
  const physical=()=>({target,lines:[{product_id:'water',name:'Ус',actual_count:actual,approved_quantity:1,target_quantity:2}]});
  const approval=()=>({approval_id:'approval',actor_label:'Менежер',reason:'Бүх бодит тоог шалгасан. Агуулахын хүргэлт хүлээж байна.',recorded_at:'2026-09-14T01:30:00Z',ready:!stale,posted:done,plan:physical()});
  const plan=()=>({counts_complete:actual!==null,counts_match:actual!==null,shortage:true,shortage_approved:approved&&!stale,shortage_approval:approved?approval():null,shortage_preview:actual!==null?{token:'a'.repeat(32),plan:physical()}:null,lines:[{product_id:'water',name:'Ус',unit:'ш',baseline_quantity:0,current_quantity:0,actual_count:actual,target_quantity:2,approved_quantity:approved&&!stale?1:undefined,stock_revision:1,warehouse_quantity:1,action_id:'count',count_matches:actual!==null,direction:'REFILL',quantity:approved&&!stale?1:2,shortage:1}]});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/auth/**',r=>r.fulfill({json:new URL(r.request().url()).pathname==='/auth/login'?{access_token:'fake-token'}:{roles:[role]}}));
  await page.route('**/hotels/**',async r=>{
   const tail=new URL(r.request().url()).pathname.replace('/hotels/test-hotel/',''),body=r.request().postDataJSON(),method=r.request().method();if(body)requests.push({tail,body,method});let result={};
   if(body&&receipts.has(body.idempotency_key))return r.fulfill({json:receipts.get(body.idempotency_key)});
   if(tail==='operations')result={roles:[role],package_mnt:30000,mode:'LIVE',staff:[],funding:[],cleaning:[],inspections:[],limit:100};
   else if(tail==='rooms')result=[room];
   else if(['room-categories','stays/active','bookings','cleaning/checkouts'].includes(tail))result=[];
   else if(tail==='rooms/101/minibar-configuration')result={room_number:'101',current:{mode:'ON',room_revision:room.revision},shortage:done?{...approval(),permit_id:'approval',target,lines:physical().lines}:null,pending:done?null:req,items:[req],next_after:null};
   else if(tail==='minibar/configuration-requests/config/reconciliation'){
    if(loadFail){loadFail=false;return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}result={request:req,plan:plan()};
   }else if(tail==='minibar/reconciliation/tasks')result={items:done?[]:[{task_id:'task',assignment_version:0,room_number:'101',work_state:'OPEN',request:req,plan:plan()}],next_after:null};
   else if(tail==='minibar/reconciliation/tasks/task/count'){
    assert.equal(role,'CLEANER');assert.equal(body.actual_count,0);actual=0;req.revision++;req.state='BLOCKED_STOCK';result={request_id:'config',revision:req.revision,state:req.state};
   }else if(tail==='minibar/configuration-requests/config/shortage-approvals'){
    assert.equal(role,'MANAGER');assert(body.physical_counts_reviewed);assert.equal(body.expected_preview,'a'.repeat(32));assert(body.reason);assert(!('opening_quantity' in body));
    if(conflict){conflict=false;req.revision++;return r.fulfill({status:409,json:{code:'REVISION_CONFLICT'}});}
    assert.equal(body.expected_revision,req.revision);approved=true;stale=false;req.revision++;result={approval_id:'approval',request_id:'config',revision:req.revision,state:'BLOCKED_STOCK'};
    if(approvalLost){approvalLost=false;receipts.set(body.idempotency_key,structuredClone(result));return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}
   }else if(tail==='minibar/reconciliation/tasks/task/apply'){
    assert.equal(role,'CLEANER');assert.equal(body.expected_revision,req.revision);assert(body.physical_transfers_confirmed);assert(approved&&!stale);
    done=true;req.revision++;req.state='APPLIED';result={request_id:'config',revision:req.revision,state:req.state,shortage_permit_id:'approval'};
    if(applyLost){applyLost=false;receipts.set(body.idempotency_key,structuredClone(result));return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}
   }else throw Error(tail);
   if(body)receipts.set(body.idempotency_key,structuredClone(result));await r.fulfill({json:result});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false'&&!document.querySelector('form[aria-busy="true"]'));
  const login=async view=>{await page.goto('about:blank');await page.goto(origin+'/reception#'+view);await page.getByLabel('Буудлын код').fill('test-hotel');await page.getByLabel('Имэйл',{exact:true}).fill('staff@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await ready();};
  const managerPlan=async()=>{await page.getByRole('button',{name:'Минибарын тохиргоо',exact:true}).click();await page.getByRole('button',{name:'Тооллого, шилжүүлэлтийн төлөвлөгөө',exact:true}).click();};
  const form=()=>page.locator('form').filter({has:page.getByRole('heading',{name:'Дутуу minibar-тайгаар нээх зөвшөөрөл',exact:true})});
  const fill=async()=>{await form().getByLabel('Шалтгаан',{exact:true}).fill('Бүх бодит тоог шалгасан. Агуулахын хүргэлт хүлээж байна.');await form().getByLabel('Бүх барааны бодит тоо, дутуу үлдэх тоо болон тухайн хувилбарыг шалгасан').focus();await page.keyboard.press('Space');};
  const submit=()=>form().getByRole('button',{name:'Дутуу нөөцийг зөвшөөрөх',exact:true}).click();
  await login('cleaning');await page.getByRole('button',{name:'Минибарын тохиргооны ажлууд',exact:true}).click();await page.getByLabel('Өрөөнд бодитоор байгаа тоо').fill('0');await page.getByRole('button',{name:'Тооллогыг батлах',exact:true}).click();await ready();assert.equal(await page.getByRole('button',{name:'Шилжүүлэлт, тохиргоог батлах',exact:true}).count(),0);
  role='RECEPTION';await login('rooms');await page.getByRole('button',{name:'Минибарын тохиргоо',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Дутуу нөөцийг зөвшөөрөх',exact:true}).count(),0);
  role='MANAGER';await login('rooms');await managerPlan();await page.getByRole('button',{name:'Төлөвлөгөөг дахин ачаалах',exact:true}).click();await submit();assert.equal(await page.evaluate(()=>document.activeElement.name),'reason');await fill();await submit();await form().locator('.result.error').waitFor();
  await page.locator('#refresh').click();await page.locator('#leave').click();await ready();await managerPlan();await fill();
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/minibar-shortages-desktop.png',fullPage:true});await page.setViewportSize({width:320,height:760});await page.emulateMedia({reducedMotion:'reduce'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'artifacts/minibar-shortages-mobile.png',fullPage:true});
  await submit();await form().locator('.result.error').waitFor();await submit();await ready();
  stale=true;role='CLEANER';await login('cleaning');await page.getByRole('button',{name:'Минибарын тохиргооны ажлууд',exact:true}).click();await page.getByText('Дутуу нөөцийн зөвшөөрлийг дахин шалгуулах шаардлагатай',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Шилжүүлэлт, тохиргоог батлах',exact:true}).count(),0);
  role='MANAGER';await login('rooms');await managerPlan();await fill();await submit();await ready();
  role='CLEANER';await login('cleaning');await page.getByRole('button',{name:'Минибарын тохиргооны ажлууд',exact:true}).click();await page.getByText('Дутуу — Manager зөвшөөрсөн',{exact:true}).waitFor();await page.getByLabel('Дээрх бүх шилжүүлэлтийг биечлэн гүйцэтгэсэн').check();await page.getByRole('button',{name:'Шилжүүлэлт, тохиргоог батлах',exact:true}).click();await page.locator('.result.error').waitFor();await page.getByRole('button',{name:'Шилжүүлэлт, тохиргоог батлах',exact:true}).click();await ready();await page.getByText('Өөрт тань оноосон тохиргооны ажил алга.',{exact:true}).waitFor();
  role='RECEPTION';await login('rooms');await page.getByRole('button',{name:'Минибарын тохиргоо',exact:true}).click();await page.getByText('Дутуу — Manager зөвшөөрсөн',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Дутуу нөөцийг зөвшөөрөх',exact:true}).count(),0);
  const approvals=requests.filter(x=>x.tail.endsWith('/shortage-approvals'));assert.equal(approvals.length,4);assert.deepEqual(approvals[1].body,approvals[2].body);assert.notEqual(approvals[0].body.idempotency_key,approvals[1].body.idempotency_key);
  const applies=requests.filter(x=>x.tail.endsWith('/apply'));assert.deepEqual(applies[0].body,applies[1].body);assert(done);assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.deepEqual(errors,[]);
  fs.writeFileSync('artifacts/minibar-shortages-requests.json',JSON.stringify(requests));console.log('Minibar shortage browser: count, reviewed Manager approval, validation/keyboard, load/CAS recovery, stale approval, apply retries, Reception read-only, 320px and privacy passed.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
