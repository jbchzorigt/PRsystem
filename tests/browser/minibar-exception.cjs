const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');
 await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})}).catch(e=>{server.close();throw e;});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),origin=`http://127.0.0.1:${server.address().port}`,requests=[],errors=[],receipts=new Map();
  let role='RECEPTION',state=null,revision=0,latest=null;
  const room={room_id:'101',number:'101',category_id:'standard',category_name:'Стандарт',status:'ACTIVE',cleaning_state:'CLEAN',minibar_mode:'ON',revision:3};
  const stay={stay_id:'stay',room_id:'101',kind:'NIGHTLY',actual_checkin_at:'2026-09-10T01:00:00Z',planned_checkout_at:'2026-09-11T04:00:00Z',amount_mnt:80000};
  const book={mode:'CANONICAL',template_id:'standard',template_name:'Стандарт',version_id:'v1',version_number:1,recorded_at:'2026-09-10T01:00:00Z',items:[{product_id:'water',name:'Ус',unit:'ш',opening_quantity:2,unit_price:3000},{product_id:'juice',name:'Жүүс',unit:'ш',opening_quantity:1,unit_price:4000}]};
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/auth/**',r=>r.fulfill({json:new URL(r.request().url()).pathname==='/auth/login'?{access_token:'fake-token'}:{roles:[role]}}));
  await page.route('**/hotels/**',async r=>{
   const u=new URL(r.request().url()),tail=u.pathname.replace('/hotels/test-hotel/',''),body=r.request().postDataJSON(),method=r.request().method();
   if(body)requests.push({tail,body,method});let result={};
   if(body&&receipts.has(body.idempotency_key)){await r.fulfill({json:receipts.get(body.idempotency_key)});return;}
   if(tail==='operations')result={roles:[role],package_mnt:25000,mode:'LIVE',staff:[],funding:[],cleaning:[],inspections:[],limit:100};
   else if(tail==='rooms')result=[room];
   else if(tail==='stays/active')result=[stay];
   else if(['room-categories','bookings','cleaning/checkouts'].includes(tail))result=[];
   else if(tail==='stays/stay/finance')result={balance:{revision:1,available:0,refund_reserved:0},charge_unpaid_mnt:0,charges:[],receipts:[],payment_intents:[],refunds:[],corrections:[]};
   else if(tail==='stays/stay/guest')result={room_number:'101',guest:{family_name:'Бат',given_name:'Болд'}};
   else if(tail==='stays/stay/checkout/preview')result={price_book:book,inspection:state?{state,revision}:null,report:latest,restaurant_orders:[]};
   else if(tail==='stays/stay/checkout/initiate'){assert.equal(role,'RECEPTION');state='REQUESTED';result={stay_id:'stay',minibar_report_required:true};}
   else if(tail==='stays/stay/minibar-exception-report'){
    assert.equal(role,'MANAGER');assert.equal(body.expected_revision,revision);assert(body.reason.trim());assert(!('task_id' in body));assert(!('unit_price' in body));
    const items=book.items.map(i=>({...i,used_quantity:i.opening_quantity-body.counts[i.product_id],actual_count:body.counts[i.product_id],line_amount:(i.opening_quantity-body.counts[i.product_id])*i.unit_price}));
    const total=items.reduce((sum,i)=>sum+i.line_amount,0);assert.equal(body.no_consumption,total===0);revision++;state='REPORTED';latest={revision,items,amount_mnt:total,exception_reason:body.reason};result={amount_mnt:total,report_revision:revision,mode:'CANONICAL',exception:true};receipts.set(body.idempotency_key,result);
    await r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});return;
   }else if(tail==='stays/stay/minibar-review'){assert.equal(role,'RECEPTION');assert.equal(body.action,'RETURN');assert(body.reason);state='REQUESTED';result={state};}
   else throw Error('Unexpected request: '+tail);
   if(body)receipts.set(body.idempotency_key,structuredClone(result));await r.fulfill({json:result});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false'&&!document.querySelector('form[aria-busy="true"]'));
  const login=async view=>{await page.goto('about:blank');await page.goto(origin+'/reception#'+view);await page.getByLabel('Буудлын код').fill('test-hotel');await page.getByLabel('Имэйл',{exact:true}).fill('staff@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await ready();};
  await login('guests');await page.getByRole('button',{name:'Байрлалт нээх',exact:true}).click();await page.getByRole('region',{name:'Check-in үеийн минибар',exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'Зочны минибарын үнэ',exact:true}).count(),1);
  await page.getByRole('button',{name:'Checkout эхлүүлэх',exact:true}).click();await page.locator('form').filter({has:page.getByRole('heading',{name:'Checkout эхлүүлэх',exact:true})}).getByRole('button',{name:'Бүртгэх',exact:true}).click();await ready();assert.equal(state,'REQUESTED');
  role='MANAGER';await login('guests');await page.getByRole('button',{name:'Байрлалт нээх',exact:true}).click();
  const exceptionForm=()=>page.locator('form').filter({has:page.getByRole('heading',{name:'Онцгой минибар тайлан',exact:true})});
  await exceptionForm().getByRole('button',{name:'Онцгой тайлан илгээх',exact:true}).click();assert.equal(await page.evaluate(()=>document.activeElement.name),'count_0');
  await exceptionForm().locator('[name=count_0]').fill('1');await exceptionForm().locator('[name=count_1]').fill('0');await exceptionForm().getByRole('button',{name:'Онцгой тайлан илгээх',exact:true}).click();assert.equal(await page.evaluate(()=>document.activeElement.name),'reason');await exceptionForm().getByLabel('Шалтгаан',{exact:true}).fill('Cleaner боломжгүй тул биечлэн шалгасан');
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/minibar-exception-desktop.png',fullPage:true});await page.setViewportSize({width:320,height:760});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'artifacts/minibar-exception-mobile.png',fullPage:true});
  await exceptionForm().getByRole('button',{name:'Онцгой тайлан илгээх',exact:true}).click();await exceptionForm().locator('.result.error').waitFor();await exceptionForm().getByRole('button',{name:'Онцгой тайлан илгээх',exact:true}).click();await page.getByText('Онцгой минибар тайлан · Cleaner боломжгүй тул биечлэн шалгасан',{exact:true}).waitFor();assert.equal(latest.amount_mnt,7000);
  role='RECEPTION';await login('guests');await page.getByRole('button',{name:'Байрлалт нээх',exact:true}).click();let f=page.locator('form').filter({has:page.getByRole('heading',{name:'Минибарын тайлан хянах',exact:true})});await f.getByLabel('Шалтгаан',{exact:true}).fill('Дахин тоолох шаардлагатай');await f.getByRole('button',{name:'Шийдвэр бүртгэх',exact:true}).click();await ready();
  role='MANAGER';await login('guests');await page.getByRole('button',{name:'Байрлалт нээх',exact:true}).click();await exceptionForm().locator('[name=count_0]').fill('2');await exceptionForm().locator('[name=count_1]').fill('1');await exceptionForm().getByLabel('Минибар хэрэглээгүйг шалгаж баталсан').check();await exceptionForm().getByLabel('Шалтгаан',{exact:true}).fill('Дахин тоолоход хэрэглээгүй байсан');await exceptionForm().getByRole('button',{name:'Онцгой тайлан илгээх',exact:true}).click();await exceptionForm().locator('.result.error').waitFor();await exceptionForm().getByRole('button',{name:'Онцгой тайлан илгээх',exact:true}).click();await page.getByText('Онцгой минибар тайлан · Дахин тоолоход хэрэглээгүй байсан',{exact:true}).waitFor();assert.equal(latest.amount_mnt,0);
  const calls=requests.filter(x=>x.tail.endsWith('/minibar-exception-report'));assert.equal(calls.length,4);assert.equal(calls[0].body.idempotency_key,calls[1].body.idempotency_key);assert.equal(calls[2].body.idempotency_key,calls[3].body.idempotency_key);
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.deepEqual(errors,[]);fs.writeFileSync('artifacts/minibar-exception-requests.json',JSON.stringify(requests));
  console.log('Manager minibar exception browser: reason, physical counts, locked prices, no-use correction, lost-response replay and 320px layout passed.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
