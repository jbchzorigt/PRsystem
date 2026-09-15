const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');
 await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})}).catch(e=>{server.close();throw e;});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),origin=`http://127.0.0.1:${server.address().port}`,requests=[],errors=[],receipts=new Map();
  let role='MANAGER',revision=1,financeRevision=3,corrected=false,conflict=true,failRead=true,reserved=false;
  const room={room_id:'101',number:'101',category_id:'standard',category_name:'Стандарт',status:'ACTIVE',cleaning_state:'CLEAN',minibar_mode:'ON',revision:3};
  const stay={stay_id:'stay',room_id:'101',kind:'NIGHTLY',actual_checkin_at:'2026-09-11T01:00:00Z',planned_checkout_at:'2026-09-12T04:00:00Z',amount_mnt:80000};
  const book={mode:'CANONICAL',template_id:'standard',template_name:'Стандарт',version_id:'v1',version_number:1,recorded_at:'2026-09-11T01:00:00Z',items:[{product_id:'water',name:'Ус',unit:'ш',opening_quantity:2,unit_price:3000}]};
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/auth/**',r=>r.fulfill({json:new URL(r.request().url()).pathname==='/auth/login'?{access_token:'fake-token'}:{roles:[role]}}));
  await page.route('**/hotels/**',async r=>{
   const tail=new URL(r.request().url()).pathname.replace('/hotels/test-hotel/',''),body=r.request().postDataJSON(),method=r.request().method();if(body)requests.push({tail,body,method});let result={};
   if(body&&receipts.has(body.idempotency_key))return r.fulfill({json:receipts.get(body.idempotency_key)});
   if(tail==='operations')result={roles:[role],package_mnt:25000,mode:'LIVE',staff:[],funding:[],cleaning:[],inspections:[],limit:100};
   else if(tail==='rooms')result=[room];else if(tail==='stays/active')result=[stay];
   else if(['room-categories','bookings','cleaning/checkouts'].includes(tail))result=[];
   else if(tail==='stays/stay/finance'){
    if(failRead){failRead=false;return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}
    result={balance:{revision:financeRevision,available:corrected?3000:0,refund_reserved:0},charge_unpaid_mnt:0,pending_payment_mnt:0,charges:[{id:'charge',kind:'MINIBAR',amount_mnt:corrected?3000:6000,paid_mnt:corrected?3000:6000}],receipts:[{id:'payment',purpose:'PAYMENT',channel:'CASH',amount_mnt:6000,allocated:corrected?3000:6000,refund_reserved:0,refunded:0,reversed:0,refund_eligible:corrected}],payment_intents:[],refunds:reserved?[{id:'refund',state:'RESERVED',amount_mnt:3000}]:[],corrections:[]};
   }else if(tail==='stays/stay/guest')result={room_number:'101',guest:{family_name:'Бат',given_name:'Болд'}};
   else if(tail==='stays/stay/checkout/preview')result={price_book:book,availability:{water:{physical_quantity:2}},inspection:{state:'REPORTED',revision},report:{revision,items:[],amount_mnt:corrected?3000:6000},restaurant_orders:[]};
   else if(tail==='stays/stay/minibar-paid-corrections'){
    assert.equal(role,'MANAGER');assert.deepEqual(body.counts,{water:1});assert(body.reason);assert(!('unit_price' in body));assert(!('reviewed' in body));
    if(conflict){conflict=false;financeRevision++;return r.fulfill({status:409,json:{code:'REVISION_CONFLICT'}});}
    assert.equal(body.expected_revision,revision);assert.equal(body.expected_finance_revision,financeRevision);revision++;financeRevision+=3;corrected=true;
    result={correction_id:'correction',report_revision:revision,amount_mnt:3000,reallocated_mnt:3000,new_receivable_mnt:0,refundable_credits:[{receipt_id:'payment',amount_mnt:3000}]};receipts.set(body.idempotency_key,result);return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});
   }else if(tail==='stays/stay/refunds'){assert.equal(role,'RECEPTION');assert.equal(body.receipt_id,'payment');assert.equal(body.amount_mnt,3000);reserved=true;financeRevision++;result={refund_id:'refund',state:'RESERVED'};}
   else if(tail==='stays/stay/refunds/refund/complete'){assert.equal(role,'RECEPTION');assert(body.recipient_confirmation);assert.equal(body.expected_revision,financeRevision);reserved=false;result={refund_id:'refund',state:'COMPLETED'};}
   else throw Error(tail);
   if(body)receipts.set(body.idempotency_key,result);await r.fulfill({json:result});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false'&&!document.querySelector('form[aria-busy="true"]'));
  const login=async()=>{await page.goto('about:blank');await page.goto(origin+'/reception#guests');await page.getByLabel('Буудлын код').fill('test-hotel');await page.getByLabel('Имэйл',{exact:true}).fill('manager@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await ready();};
  await login();await page.getByRole('button',{name:'Байрлалт нээх',exact:true}).click();await page.locator('#content .error').waitFor();await page.locator('#refresh').click();await ready();await page.getByRole('button',{name:'Байрлалт нээх',exact:true}).click();
  const form=()=>page.locator('form').filter({has:page.getByRole('heading',{name:'Төлсөн минибарын тоо залруулах',exact:true})});
  const fill=async()=>{await form().getByLabel('Ус — залруулсан бодит үлдэгдэл').fill('1');await form().getByLabel('Шалтгаан',{exact:true}).fill('Бодит тоог дахин шалгасан');await form().getByLabel('Бодит тоо, төлбөрийн өөрчлөлтийг шалгасан').check();};
  await form().getByRole('button',{name:'Төлсөн тайланг залруулах'}).click();assert.equal(await page.evaluate(()=>document.activeElement.name),'paid_count_0');await fill();await form().getByRole('button',{name:'Төлсөн тайланг залруулах'}).click();await form().locator('.result.error').waitFor();
  await page.locator('#refresh').click();await page.locator('#leave').click();await ready();await page.getByRole('button',{name:'Байрлалт нээх',exact:true}).click();await fill();
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/minibar-paid-correction-desktop.png',fullPage:true});await page.setViewportSize({width:320,height:760});await page.emulateMedia({reducedMotion:'reduce'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'artifacts/minibar-paid-correction-mobile.png',fullPage:true});
  await form().getByRole('button',{name:'Төлсөн тайланг залруулах'}).click();await form().locator('.result.error').waitFor();await form().getByRole('button',{name:'Төлсөн тайланг залруулах'}).click();await ready();
  role='RECEPTION';await login();await page.getByRole('button',{name:'Байрлалт нээх',exact:true}).click();await page.getByRole('button',{name:'Буцаалт нөөцлөх',exact:true}).click();
  const refund=page.locator('form').filter({has:page.getByRole('heading',{name:'Илүү төлөлтийн буцаалт',exact:true})});await refund.locator('[name=amount_mnt]').fill('3000');await refund.locator('[name=channel]').selectOption('CASH');await refund.locator('[name=recipient]').fill('Зочин');await refund.locator('[name=reason]').fill('Илүү төлөлт');await refund.getByRole('button',{name:'Бүртгэх',exact:true}).click();await ready();
  await page.getByRole('button',{name:'Байрлалт шинэчлэх',exact:true}).click();
  const complete=page.locator('form').filter({has:page.getByRole('heading',{name:'Биечлэн дууссан буцаалтыг батлах',exact:true})});await complete.locator('[name=recipient_confirmation]').fill('Зочин хүлээн авсан');await complete.getByRole('button',{name:'Бүртгэх',exact:true}).click();await ready();assert.equal(reserved,false);
  const calls=requests.filter(x=>x.tail.endsWith('/minibar-paid-corrections'));assert.equal(calls.length,3);assert.deepEqual(calls[1].body,calls[2].body);assert.notEqual(calls[0].body.idempotency_key,calls[1].body.idempotency_key);
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.deepEqual(errors,[]);fs.writeFileSync('artifacts/minibar-paid-correction-requests.json',JSON.stringify(requests));console.log('Paid minibar correction browser: read failure, validation, CAS, exact retry, locked price, refundable payment, 320px and privacy passed.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
