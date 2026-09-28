const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');
 await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})}).catch(e=>{server.close();throw e;});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),origin=`http://127.0.0.1:${server.address().port}`,requests=[],errors=[],receipts=new Map();
  let role='RECEPTION',serial=0,loadFail=true,lost=true;
  const rows=[],room={room_id:'101',number:'101',category_id:'standard',category_name:'Стандарт',status:'ACTIVE',cleaning_state:'CLEAN',minibar_mode:'ON',revision:3};
  const stay={stay_id:'stay',room_id:'101',kind:'NIGHTLY',actual_checkin_at:'2026-09-10T01:00:00Z',planned_checkout_at:'2026-09-11T04:00:00Z',amount_mnt:80000};
  const book={mode:'CANONICAL',template_name:'Стандарт',version_number:1,recorded_at:stay.actual_checkin_at,items:[{product_id:'water',name:'Ус',unit:'ш',opening_quantity:2,unit_price:3000}]};
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/auth/**',r=>r.fulfill({json:new URL(r.request().url()).pathname==='/auth/login'?{access_token:'fake-token'}:{roles:[role]}}));
  await page.route('**/hotels/**',async r=>{
   const tail=new URL(r.request().url()).pathname.replace('/hotels/test-hotel/',''),body=r.request().postDataJSON(),method=r.request().method();
   if(body)requests.push({tail,body,method});let result={};
   if(body&&receipts.has(body.idempotency_key)){await r.fulfill({json:receipts.get(body.idempotency_key)});return;}
   if(tail==='operations')result={roles:[role],package_mnt:25000,mode:'LIVE',staff:[],funding:[],cleaning:[],inspections:[],limit:100};
   else if(tail==='rooms')result=[room];else if(tail==='stays/active')result=[stay];
   else if(['room-categories','bookings','cleaning/checkouts'].includes(tail))result=[];
   else if(tail==='stays/stay/finance')result={balance:{revision:1,available:0,refund_reserved:0},charge_unpaid_mnt:0,charges:[],receipts:[],payment_intents:[],refunds:[],corrections:[]};
   else if(tail==='stays/stay/guest')result={room_number:'101',guest:{family_name:'Бат',given_name:'Болд'}};
   else if(tail==='stays/stay/checkout/preview')result={price_book:book,inspection:null,report:null,restaurant_orders:[]};
   else if(tail==='stays/stay/minibar-refills'&&method==='GET')result={items:rows,next_after:null};
   else if(tail==='stays/stay/minibar-refills'){
    assert.equal(role,'RECEPTION');assert.equal(body.product_id,'water');assert(body.quantity>0);
    result={request_id:'request-'+(++serial),stay_id:'stay',room_id:'101',room_number:'101',product_id:'water',product:{product_id:'water',name:'Ус',unit:'ш'},requested_quantity:body.quantity,state:'PENDING',revision:0,task_id:null};rows.push(result);
   }else if(tail==='minibar/refill-tasks'){
    assert.equal(role,'CLEANER');if(loadFail){loadFail=false;await r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});return;}
    result={items:rows.filter(x=>x.state==='PENDING'),next_after:null};
   }else if(tail.startsWith('minibar/refills/')){
    const q=rows.find(x=>tail.includes('/'+x.request_id+'/'));assert(q);assert.equal(q.state,'PENDING');assert.equal(body.expected_revision,0);
    if(tail.endsWith('/claim')){assert.equal(role,'CLEANER');Object.assign(q,{task_id:'task-'+q.request_id,assignment_version:0,work_state:'OPEN'});}
    else if(tail.endsWith('/complete')){assert.equal(role,'CLEANER');assert.equal(body.task_id,q.task_id);assert.equal(body.assignment_version,0);assert(body.quantity<=q.requested_quantity);assert(!('unit_price' in body));Object.assign(q,{state:'COMPLETED',revision:1,actual_quantity:body.quantity});}
    else if(tail.endsWith('/cancel')){assert.equal(role,'RECEPTION');assert(body.reason.trim());Object.assign(q,{state:'CANCELLED',revision:1,reason:body.reason});}
    else if(tail.endsWith('/unavailable')){assert.equal(role,'CLEANER');assert(body.reason.trim());Object.assign(q,{state:'UNAVAILABLE',revision:1,reason:body.reason});}
    else throw Error(tail);
    result=q;
    if(tail.endsWith('/complete')&&lost){lost=false;receipts.set(body.idempotency_key,structuredClone(result));await r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});return;}
   }else throw Error('Unexpected request: '+tail);
   if(body)receipts.set(body.idempotency_key,structuredClone(result));await r.fulfill({json:result});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false'&&!document.querySelector('form[aria-busy="true"]'));
  const login=async view=>{await page.goto('about:blank');await page.goto(origin+'/reception#'+view);await page.getByLabel('Буудлын код').fill('test-hotel');await page.getByLabel('Имэйл',{exact:true}).fill('staff@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await ready();};
  await login('guests');await page.getByRole('button',{name:'Байрлалт нээх',exact:true}).click();await page.getByRole('button',{name:'Минибар нөхөх хүсэлтүүд',exact:true}).click();
  const requestForm=()=>page.locator('form').filter({has:page.getByRole('heading',{name:'Минибар нөхөх хүсэлт',exact:true})});
  await requestForm().getByRole('button',{name:'Нөхөх хүсэлт илгээх',exact:true}).click();assert.equal(await page.evaluate(()=>document.activeElement.name),'quantity');
  for(let i=0;i<3;i++){await requestForm().getByLabel('Хүсэх тоо',{exact:true}).fill('2');await requestForm().getByRole('button',{name:'Нөхөх хүсэлт илгээх',exact:true}).click();await page.getByRole('heading',{name:'Минибар нөхөх хүсэлт',exact:true}).waitFor();await ready();}
  assert.equal(rows.length,3);
  let cancel=page.locator('form').filter({has:page.getByRole('heading',{name:'Нөхөх хүсэлтийг цуцлах',exact:true})}).last();await cancel.getByLabel('Шалтгаан',{exact:true}).fill('Зочин хүсэлтээ цуцалсан');await cancel.getByRole('button',{name:'Хүсэлт цуцлах',exact:true}).click();await ready();assert.equal(rows[2].state,'CANCELLED');
  role='CLEANER';await login('cleaning');await page.getByRole('button',{name:'Минибар нөхөх ажлууд',exact:true}).click();await page.getByRole('button',{name:'Нөхөх ажлыг дахин ачаалах',exact:true}).click();await page.getByRole('button',{name:'Нөхөх ажлыг өөртөө авах',exact:true}).first().click();
  const physical=()=>page.locator('form').filter({has:page.getByRole('heading',{name:'Бодит нөхөлт',exact:true})});await physical().waitFor();
  assert.equal(await page.getByText('3,000',{exact:false}).count(),0);
  await physical().getByRole('button',{name:'Нөхсөнийг батлах',exact:true}).click();assert.equal(await page.evaluate(()=>document.activeElement.name),'quantity');await physical().getByLabel('Бодитоор нөхсөн тоо',{exact:true}).fill('3');await physical().getByRole('button',{name:'Нөхсөнийг батлах',exact:true}).click();await physical().locator('.result.error').waitFor();assert.equal(requests.filter(x=>x.tail.endsWith('/complete')).length,0);
  await physical().getByLabel('Бодитоор нөхсөн тоо',{exact:true}).fill('1');await page.getByRole('button',{name:'Нөхөх ажлыг шинэчлэх',exact:true}).click();await page.locator('#discard').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>document.activeElement.id),'keep');await page.locator('#keep').click();
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/minibar-refill-desktop.png',fullPage:true});await page.setViewportSize({width:320,height:760});await page.emulateMedia({reducedMotion:'reduce'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'artifacts/minibar-refill-mobile.png',fullPage:true});
  await physical().getByRole('button',{name:'Нөхсөнийг батлах',exact:true}).click();await physical().locator('.result.error').waitFor();assert.equal(await physical().getByLabel('Бодитоор нөхсөн тоо',{exact:true}).inputValue(),'1');await physical().getByRole('button',{name:'Нөхсөнийг батлах',exact:true}).click();await page.getByRole('button',{name:'Нөхөх ажлыг өөртөө авах',exact:true}).waitFor();
  await page.getByRole('button',{name:'Нөхөх ажлыг өөртөө авах',exact:true}).click();const unavailable=page.locator('form').filter({has:page.getByRole('heading',{name:'Нөхөх боломжгүй',exact:true})});await unavailable.getByLabel('Шалтгаан',{exact:true}).fill('Агуулахад үлдээгүй');await unavailable.getByRole('button',{name:'Боломжгүй гэж хаах',exact:true}).click();await page.getByText('Өөрт авах боломжтой эсвэл танд оноосон нөхөх ажил алга.',{exact:true}).waitFor();
  assert.deepEqual(rows.map(x=>x.state),['COMPLETED','UNAVAILABLE','CANCELLED']);const completed=requests.filter(x=>x.tail.endsWith('/complete'));assert.equal(completed.length,2);assert.equal(completed[0].body.idempotency_key,completed[1].body.idempotency_key);
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.deepEqual(errors,[]);fs.writeFileSync('artifacts/minibar-refill-requests.json',JSON.stringify(requests));
  console.log('Minibar refill browser: request, cancellation, assignment, physical quantity, unavailable reason, unknown-outcome replay, dirty guard and 320px layout passed.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
