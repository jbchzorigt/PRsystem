const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');
 await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})}).catch(e=>{server.close();throw e;});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),origin=`http://127.0.0.1:${server.address().port}`,requests=[],errors=[],receipts=new Map(),reads=[];
  let role='MANAGER',revision=0,financeRevision=3,quantity=2,conflict=true,failList=true,failDetail=true,reserved=false,refunded=false,blocked=false,unauthenticated=false,delayDetail=null;
  let chargePaid=6000;
  const stay={stay_id:'old-stay',room_id:'101',room_number:'101',check_in_recorded_at:'2026-09-11T01:00:00Z',actual_checkout_at:'2026-09-12T04:00:00Z'};
  const lines=()=>[{product_id:'water',name:'Ус',unit:'ш',original_quantity:2,billable_limit:2,quantity,unit_price:3000,line_amount:quantity*3000},{product_id:'juice',name:'Жүүс',unit:'ш',original_quantity:0,billable_limit:0,quantity:0,unit_price:4500,line_amount:0}];
  const history=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/auth/**',r=>r.fulfill({json:new URL(r.request().url()).pathname==='/auth/login'?{access_token:'fake-token'}:{roles:[role]}}));
  await page.route('**/hotels/**',async r=>{
   const url=new URL(r.request().url()),tail=url.pathname.replace('/hotels/test-hotel/',''),body=r.request().postDataJSON(),method=r.request().method();if(body)requests.push({tail,body,method});else reads.push(tail+url.search);let result={};
   if(unauthenticated&&tail.endsWith('minibar-billing-corrections'))return r.fulfill({status:401,json:{code:'UNAUTHENTICATED'}});
   if(body&&receipts.has(body.idempotency_key))return r.fulfill({json:receipts.get(body.idempotency_key)});
   if(tail==='operations')result={roles:[role],package_mnt:30000,mode:'LIVE',staff:[],funding:[],cleaning:[],inspections:[],limit:100};
   else if(['rooms','stays/active','room-categories','bookings','cleaning/checkouts'].includes(tail))result=[];
   else if(tail==='minibar/billing-stays'){
    if(failList){failList=false;return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}
    result=url.searchParams.get('after')?{items:[],next_after:null}:{items:[stay],next_after:'old-stay'};
   }else if(tail==='stays/old-stay/minibar-billing'){
    if(delayDetail)await delayDetail;
    if(failDetail){failDetail=false;return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}
    const after=Number(url.searchParams.get('after'));
    result={basis:{original_revision:1,billing_revision:revision,previous_id:revision?'correction-'+revision:null,charge_id:quantity?'charge':null,amount_mnt:quantity*3000,items:lines()},balance:{revision:financeRevision},blocked,history:after?[]:history,next_after:history.length&&!after?revision:null};
   }else if(tail==='stays/old-stay/finance'){
    result={balance:{revision:financeRevision,available:!refunded&&revision&&quantity<2?3000:0,refund_reserved:reserved?3000:0,frozen:blocked},charge_unpaid_mnt:quantity*3000-chargePaid,pending_payment_mnt:0,charges:[{id:'charge',kind:'MINIBAR',amount_mnt:quantity*3000,paid_mnt:chargePaid},{id:'unrelated',kind:'ROOM',amount_mnt:80000,paid_mnt:0}],receipts:[{id:'payment',purpose:'PAYMENT',channel:'CASH',amount_mnt:6000,allocated:chargePaid,refund_reserved:reserved?3000:0,refunded:refunded?3000:0,reversed:0,refund_eligible:revision>0}],payment_intents:[],refunds:reserved?[{id:'refund',state:'RESERVED',amount_mnt:3000}]:[],corrections:[]};
   }else if(tail==='stays/old-stay/minibar-billing-corrections'){
    assert(['MANAGER','MANAGER_PLUS'].includes(role));assert(body.financial_only_reviewed);assert(body.reason);assert.deepEqual(Object.keys(body).sort(),['expected_finance_revision','expected_report_revision','expected_revision','financial_only_reviewed','idempotency_key','quantities','reason'].sort());
    if(conflict){conflict=false;financeRevision++;return r.fulfill({status:409,json:{code:'REVISION_CONFLICT'}});}
    assert.equal(body.expected_revision,revision);assert.equal(body.expected_report_revision,1);assert.equal(body.expected_finance_revision,financeRevision);assert.equal(body.quantities.juice,0);
    quantity=body.quantities.water;revision++;financeRevision++;chargePaid=Math.min(chargePaid,quantity*3000);
    history.push({billing_revision:revision,amount_mnt:quantity*3000,actor_label:'Бат менежер',reason:body.reason,recorded_at:'2026-09-14T01:00:00Z',items:lines()});
    result={billing_revision:revision,amount_mnt:quantity*3000,new_receivable_mnt:Math.max(0,quantity*3000-chargePaid),refundable_credits:quantity<2?[{receipt_id:'payment',amount_mnt:3000}]:[]};receipts.set(body.idempotency_key,result);
    if(revision===1)return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});
   }else if(tail==='stays/old-stay/refunds'){assert.equal(role,'RECEPTION');assert.equal(body.receipt_id,'payment');assert.equal(body.amount_mnt,3000);assert.equal(body.expected_revision,financeRevision);reserved=true;financeRevision++;result={refund_id:'refund',state:'RESERVED'};}
   else if(tail==='stays/old-stay/refunds/refund/complete'){assert.equal(role,'RECEPTION');assert(body.recipient_confirmation);assert.equal(body.expected_revision,financeRevision);reserved=false;refunded=true;financeRevision++;result={refund_id:'refund',state:'COMPLETED'};}
   else if(tail==='stays/old-stay/cash-receipts'){assert.equal(role,'RECEPTION');assert.equal(body.charge_id,'charge');assert.equal(body.amount_mnt,3000);assert(body.received);assert.equal(body.expected_revision,financeRevision);chargePaid+=3000;financeRevision++;result={receipt_id:'new-payment',amount_mnt:3000};}
   else throw Error(tail);
   if(body)receipts.set(body.idempotency_key,result);await r.fulfill({json:result});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false'&&!document.querySelector('#content [aria-busy="true"]')&&!document.querySelector('form[aria-busy="true"]'));
  const login=async()=>{await page.goto('about:blank');await page.goto(origin+'/reception#payments');await page.getByLabel('Буудлын код').fill('test-hotel');await page.getByLabel('Имэйл',{exact:true}).fill('manager@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await ready();};
  const click=async name=>{await page.getByRole('button',{name,exact:true}).click();await ready();};
  const open=async()=>{await click('Хаасан байрлалтын минибар');await click('Хаасан байрлалтын төлбөр нээх');};
  const form=()=>page.locator('form').filter({has:page.getByRole('heading',{name:'Хаасан байрлалтын төлбөр залруулах',exact:true})});
  const fill=async n=>{await form().getByLabel('Ус — төлбөрт тооцох тоо').fill(String(n));await form().getByLabel('Шалтгаан',{exact:true}).fill('Анхны баримтыг шалгаж төлбөрийг залруулав');await form().getByRole('checkbox').check();};
  const submit=async()=>{await form().getByRole('button',{name:'Төлбөрийн залруулга батлах'}).click();await ready();};
  await login();await click('Хаасан байрлалтын минибар');await page.getByRole('button',{name:'Хаасан байрлалтыг дахин ачаалах'}).waitFor();await click('Хаасан байрлалтыг дахин ачаалах');
  await click('Хаасан байрлалтын дараагийн хэсэг');assert(await page.getByText('Энэ хэсэгт минибарын тайлантай хаасан байрлалт алга.').isVisible());assert(await page.getByRole('button',{name:'Хаасан байрлалтын дараагийн хэсэг'}).isDisabled());await click('Хаасан байрлалтын эхний хэсэг');
  await click('Хаасан байрлалтын төлбөр нээх');await page.getByRole('button',{name:'Минибарын төлбөрийг дахин ачаалах'}).waitFor();await click('Минибарын төлбөрийг дахин ачаалах');
  await submit();assert.equal(await page.evaluate(()=>document.activeElement.name),'reason');
  await fill(1);await form().getByLabel('Жүүс — төлбөрт тооцох тоо').fill('1');await submit();assert.equal(requests.length,0);await form().getByLabel('Жүүс — төлбөрт тооцох тоо').fill('0');
  await form().getByLabel('Ус — төлбөрт тооцох тоо').fill('2');await submit();assert.equal(requests.length,0);await fill(1);
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/minibar-billing-desktop.png',fullPage:true});await page.setViewportSize({width:320,height:760});await page.emulateMedia({reducedMotion:'reduce'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'artifacts/minibar-billing-mobile.png',fullPage:true});
  await submit();assert.equal(requests.length,1);assert.equal(await form().locator('[name=reason]').inputValue(),'Анхны баримтыг шалгаж төлбөрийг залруулав');
  await page.getByRole('button',{name:'Хаасан байрлалтын төлбөр шинэчлэх',exact:true}).click();await page.locator('#keep').click();assert(await form().isVisible());
  await page.getByRole('button',{name:'Хаасан байрлалтын төлбөр шинэчлэх',exact:true}).click();await page.locator('#leave').click();await ready();await fill(1);await submit();await form().locator('.result.error').waitFor();
  // An unchanged retry must replay the already accepted financial command.
  const detached=await form().elementHandle();await submit();assert.equal(revision,1);await detached.evaluate(f=>f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));await ready();assert.equal(requests.length,3);
  assert.deepEqual(requests[1].body,requests[2].body);assert.notEqual(requests[0].body.idempotency_key,requests[1].body.idempotency_key);
  assert(await page.getByText('Бат менежер · 2026.09.14 09:00').isVisible());await click('Төлбөрийн түүхийн дараагийн хэсэг');assert(await page.getByText('Энэ хэсэгт төлбөрийн залруулга алга.').isVisible());await click('Төлбөрийн түүхийн эхний хэсэг');
  role='RECEPTION';await login();await open();assert.equal(await form().count(),0);assert.equal(await page.getByRole('button',{name:'Төлбөр авах',exact:true}).count(),0);
  await click('Буцаалт нөөцлөх');const refund=page.locator('form').filter({has:page.getByRole('heading',{name:'Илүү төлөлтийн буцаалт',exact:true})});await refund.locator('[name=amount_mnt]').fill('3000');await refund.locator('[name=channel]').focus();await page.keyboard.press('Space');await page.keyboard.press('Escape');await refund.locator('[name=channel]').selectOption('CASH');await refund.locator('[name=recipient]').fill('Зочин');await refund.locator('[name=reason]').fill('Илүү төлөлт');await refund.getByRole('button',{name:'Бүртгэх',exact:true}).click();await ready();
  await click('Хаасан байрлалтын төлбөр шинэчлэх');const complete=page.locator('form').filter({has:page.getByRole('heading',{name:'Биечлэн дууссан буцаалтыг батлах',exact:true})});await complete.locator('[name=recipient_confirmation]').fill('Зочин хүлээн авсан');await complete.getByRole('button',{name:'Бүртгэх',exact:true}).click();await ready();assert(refunded);
  role='MANAGER_PLUS';await login();await open();await fill(2);await submit();assert.equal(revision,2);
  role='RECEPTION';await login();await open();assert.equal(await page.getByRole('button',{name:'Төлбөр авах',exact:true}).count(),1);await click('Төлбөр авах');await click('Дүн оруулах');const payment=page.locator('form').filter({has:page.getByRole('heading',{name:'Бэлэн төлбөр',exact:true})});await payment.getByRole('checkbox').check();await payment.getByRole('button',{name:'Төлбөр бүртгэх'}).click();await ready();assert.equal(chargePaid,6000);
  role='MANAGER';blocked=true;await login();await open();assert.equal(await form().count(),0);blocked=false;
  // Detached reads cannot repopulate another destination.
  await click('Хаасан байрлалтын жагсаалт');let resolve;delayDetail=new Promise(r=>resolve=r);await page.getByRole('button',{name:'Хаасан байрлалтын төлбөр нээх',exact:true}).click();await page.getByRole('link',{name:'Өрөөнүүд',exact:true}).click();resolve();delayDetail=null;await ready();assert.equal(await form().count(),0);
  await page.getByRole('link',{name:'Төлбөр',exact:true}).click();await ready();await open();await fill(1);unauthenticated=true;await submit();await page.locator('#login').waitFor({state:'visible'});assert.equal(await page.locator('#content').textContent(),'');
  assert(!reads.some(x=>/guest|checkout|products/.test(x)));assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert(!new URL(page.url()).hash.includes('old-stay'));assert.deepEqual(errors,[]);
  fs.writeFileSync('artifacts/minibar-billing-requests.json',JSON.stringify(requests));console.log('Historical minibar billing browser: bounded lists/history, failures, zero bounds, locked totals, conflict/discard, exact retry, detached form/read, Manager Plus, Reception refund/collection, frozen/session denial, keyboard, 320px and privacy passed.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
