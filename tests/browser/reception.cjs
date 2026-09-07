const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),origin=`http://127.0.0.1:${server.address().port}`;
  let requests=[],failure=false,created=false,allocated=false,paid=false,closed=false,expired=false,mode='RECEPTION';const problems=[];page.on('pageerror',e=>problems.push(e.message));
  const room={room_id:'room-1',number:'101',floor:'1',category_id:'category-1',category_name:'Стандарт',status:'ACTIVE',cleaning_state:'CLEAN',revision:1,minibar_mode:'OFF',tariffs:{}};
  const stay={stay_id:'stay-1',room_id:'room-1',kind:'NIGHTLY',actual_checkin_at:'2026-09-07T01:00:00Z',planned_checkout_at:'2026-09-08T04:00:00Z',amount_mnt:80000};
  const overview=()=>({account_id:'worker',roles:[mode],package_mnt:30000,mode:'MOCK_CASH_LEDGER',limit:50,staff:[{account_id:'worker',email:'worker@example.com',roles:['RECEPTION']},{account_id:'receiver',email:'receiver@example.com',roles:['RECEPTION']}],drawers:[{drawer_id:'drawer-1',name:'Үндсэн касс',unused:false}],shifts:[{shift_id:'shift-1',owner_id:'worker',drawer_id:'drawer-1',state:'OPEN',opened_at:'2026-09-07T00:00:00Z',review_state:'NOT_SUBMITTED'}],funding:[],custodies:[],qrs:[],inspections:[],cleaning:[]});
  await page.route('**/auth/**',async route=>{const url=new URL(route.request().url());await route.fulfill({json:url.pathname==='/auth/login'?{access_token:'test-session'}:url.pathname==='/auth/me'?{roles:[mode]}:{}});});
  await page.route('**/hotels/**',async route=>{
   const url=new URL(route.request().url()),tail=url.pathname.replace('/hotels/test-hotel/',''),body=route.request().postDataJSON();requests.push({tail,body,method:route.request().method()});
   if(body)await new Promise(r=>setTimeout(r,150));
   let data={};
   if(tail==='operations'){data=overview();if(expired)Object.assign(data,{completion_only:true,rooms:[room],stays:[stay]});}
   else if(tail==='rooms')data=[room];else if(tail==='room-categories')data=[{category_id:'category-1',name:'Стандарт',status:'ACTIVE',revision:1}];
   else if(tail==='stays/active')data=created&&!closed?[stay]:[];else if(tail==='bookings'||(tail==='handovers'&&!body)||tail==='cleaning/checkouts')data=[];
   else if(tail==='stays/check-in'){
    if(failure){await route.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});return;}
    assert.equal(body.guest.identity_type,'MN_REG_NO');assert.equal(body.room_id,'room-1');assert.deepEqual(body.deposit,{channel:'CASH',amount_mnt:60000,received:true});created=true;data={stay_id:'stay-1',room_id:'room-1',guest_access_code:'123456'};
   }else if(tail==='stays/stay-1/guest')data={room_number:'101',guest:{family_name:'Бат',given_name:'Болд',identity_type:'MN_REG_NO'}};
   else if(tail==='stays/stay-1/finance')data={balance:{revision:paid?3:allocated?2:1,available:allocated?0:60000,refund_reserved:0,frozen:false},charge_unpaid_mnt:paid?0:allocated?20000:80000,charges:[{id:'charge-1',kind:'ROOM',amount_mnt:80000,paid_mnt:paid?80000:allocated?60000:0}],receipts:paid?[]:[{id:'receipt-1',purpose:'DEPOSIT',channel:'CASH',amount_mnt:60000,allocated:allocated?60000:0,refund_reserved:0,refunded:0,reversed:0}],refunds:[],corrections:[],payment_intents:[]};
   else if(tail==='stays/stay-1/checkout/preview')data={inspection:null,report:null,restaurant_orders:[]};
   else if(tail==='stays/stay-1/deposit-allocations'){assert.equal(body.amount_mnt,60000);assert.equal(body.expected_revision,1);allocated=true;data={state:'COMPLETED'};}
   else if(tail==='stays/stay-1/cash-receipts'){assert.equal(body.expected_revision,2);assert.equal(body.amount_mnt,20000);assert.equal(body.received,true);paid=true;data={state:'COMPLETED'};}
   else if(tail==='stays/stay-1/checkout'){assert.equal(body.expected_revision,3);closed=true;data={state:'CLOSED'};}
   else if(tail==='handovers'&&body){data={state:'SUBMITTED'};}
   await route.fulfill({json:data});
  });
  const login=async()=>{await page.goto(origin+'/reception');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();assert.equal(await page.locator('[name=tenant_id]').getAttribute('aria-invalid'),'true');assert.equal(await page.evaluate(()=>document.activeElement.name),'tenant_id');await page.getByLabel('Буудлын код').fill('test-hotel');await page.getByLabel('Имэйл',{exact:true}).fill('worker@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нууц үг харуулах'}).click();assert.equal(await page.locator('[name=password]').getAttribute('type'),'text');await page.getByRole('button',{name:'Нууц үг нуух'}).click();await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false');};
  await login();assert.equal(await page.getByRole('navigation',{name:'Үндсэн цэс'}).getByRole('link').count(),5);
  await page.getByRole('button',{name:'Walk-in зочин бүртгэх',exact:true}).click();await page.getByRole('button',{name:'Зочны мэдээлэл оруулах',exact:true}).click();
  await page.getByLabel('Овог',{exact:true}).fill('Бат');await page.getByRole('link',{name:'Өрөөнүүд',exact:true}).click();await page.locator('#discard').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>document.activeElement.id),'keep');await page.keyboard.press('Escape');assert.equal(await page.getByLabel('Овог',{exact:true}).inputValue(),'Бат');
  await page.getByLabel('Нэр',{exact:true}).fill('Болд');await page.getByLabel('Төрсөн огноо',{exact:true}).fill('1990-01-01');await page.getByLabel('Иргэншил',{exact:true}).fill('Монгол');await page.getByLabel('Баримтын дугаар',{exact:true}).fill('АБ90010111');await page.getByLabel('Бэлнээр авсан барьцаа (₮)',{exact:false}).fill('60000');await page.getByLabel('Бэлэн барьцааг биечлэн авсан',{exact:false}).check();
  failure=true;const submit=page.getByRole('button',{name:'Check-in баталгаажуулах',exact:true});await submit.click();await page.waitForFunction(()=>document.querySelector('.result.error'));const first=requests.filter(r=>r.tail==='stays/check-in').at(-1);assert.equal(await page.getByLabel('Овог',{exact:true}).inputValue(),'Бат');
  failure=false;await submit.click();await page.evaluate(()=>{const f=document.querySelector('[name=family_name]').form;f.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));});await page.getByRole('button',{name:'Байрлалтыг нээх',exact:true}).waitFor();const writes=requests.filter(r=>r.tail==='stays/check-in');assert.equal(writes.length,2);assert.equal(writes[1].body.idempotency_key,first.body.idempotency_key);
  await page.getByRole('button',{name:'Байрлалтыг нээх',exact:true}).click();await page.getByRole('button',{name:'Барьцаанаас суутгах',exact:true}).click();await page.getByLabel('Дүн (₮)',{exact:true}).fill('60000');await page.getByRole('form').count();await page.locator('form').filter({has:page.getByRole('heading',{name:'Барьцаанаас суутгах',exact:true})}).getByRole('button',{name:'Бүртгэх',exact:true}).click();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.result')).some(n=>n.textContent.includes('Дууссан')));await page.getByRole('button',{name:'Байрлалт шинэчлэх',exact:true}).click();await page.getByRole('button',{name:'Төлбөр авах',exact:true}).click();await page.getByRole('button',{name:'Дүн оруулах',exact:true}).click();await page.getByLabel('Бэлэн мөнгийг биечлэн авсан',{exact:true}).check();await page.getByRole('button',{name:'Төлбөр бүртгэх',exact:true}).click();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.result')).some(n=>n.textContent.includes('Дууссан')));await page.getByRole('button',{name:'Байрлалт шинэчлэх',exact:true}).click();await page.getByRole('button',{name:'Зочны checkout баталгаажуулах',exact:true}).click();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.result')).some(n=>n.textContent.includes('Хаасан')));
  assert.equal(requests.filter(r=>r.tail==='stays/stay-1/checkout').length,1);
  await page.getByRole('link',{name:'Ээлж',exact:true}).click();await page.getByLabel('Биечлэн тоолсон бэлэн мөнгө (₮)',{exact:true}).fill('0');await page.getByLabel('Хүлээн авагч',{exact:true}).selectOption('receiver');await page.getByLabel('Шалтгаан',{exact:true}).fill('Ээлж дууссан');await page.getByRole('button',{name:'Тооллого илгээж үйлдлүүдийг царцаах'}).click();await page.waitForFunction(()=>document.querySelector('form[aria-busy=false] .result')?.textContent.includes('бүртгэгдлээ'));
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  await page.setViewportSize({width:320,height:650});await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.getByRole('link',{name:'Өрөөнүүд',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false');
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/reception-mobile.png',fullPage:true});
  await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'artifacts/reception-desktop.png',fullPage:true});
  expired=true;const beforeExpired=requests.length;await login();
  assert.equal(await page.getByRole('button',{name:'Walk-in зочин бүртгэх',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'POS / банкны барьцаа бэлтгэх',exact:true}).count(),0);
  assert.match(await page.locator('#status').textContent(),/Багцын хугацаа дууссан/);
  assert.equal(requests.slice(beforeExpired).some(r=>['rooms','room-categories','stays/active','bookings'].includes(r.tail)),false);
  await page.getByRole('link',{name:'Өрөөнүүд',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false');
  assert.match(await page.locator('#content').textContent(),/101/);
  fs.writeFileSync('artifacts/reception-requests.json',JSON.stringify(requests));
  await page.route('**/guest/access',async route=>{const body=route.request().postDataJSON();assert.equal(body.qr_token,'q'.repeat(43));assert.equal(body.code,'123456');await route.fulfill({json:{access_token:'guest-session'}});});
  await page.route('**/guest/session',route=>route.fulfill({json:{room_number:'101',planned_checkout_at:'2026-09-08T04:00:00Z'}}));
  await page.goto(origin+'/guest/entry#qr='+'q'.repeat(43));assert.equal(new URL(page.url()).hash,'');await page.getByLabel('Reception-оос авсан 6 оронтой код').fill('123456');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.getByRole('heading',{name:'101 өрөөнд тавтай морил'}).waitFor();assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  assert.deepEqual(problems,[]);assert.equal(await page.locator('form:not([novalidate])').count(),0);
  console.log('Reception browser checks passed: real forms, validation, retry/idempotency, dirty modal, cash payment, checkout, handover, responsive and private storage.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
