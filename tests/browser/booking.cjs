const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));let browser;
 try{
  browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})});
  const page=await browser.newPage({viewport:{width:1280,height:900}}),origin=`http://127.0.0.1:${server.address().port}`;const requests=[],problems=[];page.on('pageerror',e=>problems.push(e.message));
  const quote={planned_checkin_at:'2026-10-10T06:00:00Z',planned_checkout_at:'2026-10-12T04:00:00Z',nights:2,amount_mnt:160000,unit_price:80000};
  const booking={booking_id:'booking-1',tenant_id:'hotel-1',category_id:'category-1',access_token:'g'.repeat(43),quote,booking_state:'HOLDING',refund_remaining_mnt:0,refunded_mnt:0,attempts:[]};let mine=[],failed=true;
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),p=url.pathname;if(p.startsWith('/staff/assets/')||['/booking','/platform/booking'].includes(p))return route.continue();
   let body=req.postDataJSON();requests.push({path:p,method:req.method(),body});let data={};
   if(p==='/booker/auth/login')data={access_token:'b'.repeat(43)};
   else if(p==='/booker/bookings')data=mine;
   else if(p==='/public/booking-hotels')data={items:[{tenant_id:'hotel-1',name:'Туршилтын буудал',address:'Улаанбаатар',phone:'+97699112233',description:'Төвд байрлах буудал',latitude:47.9,longitude:106.9,photos:[],review_count:0,accepting:true,categories:[{category_id:'category-1',name:'Стандарт',available:1,photos:[],quote}]}],next_after:null};
   else if(p==='/booker/hotels/hotel-1/bookings'){
    if(failed){failed=false;return route.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}mine=[booking];data=booking;
   }else if(p.endsWith('/reconcile'))data=booking;
   else if(p.endsWith('/cancel')){booking.booking_state='CANCELLED_GUEST';data=booking;}
   else if(p==='/platform/auth/login')data={access_token:'p'.repeat(43)};
   else if(p.endsWith('/booking-finance'))data={bookings:[{booking_id:'booking-1',state:'ELIGIBLE',net_mnt:77000,commission_mnt:3000}],batches:[{batch_id:'batch-1',amount_mnt:77000,state:'BATCHED'}]};
   else if(p.endsWith('/execute'))data={batch_id:'batch-1',attempt_id:'attempt-1',state:'PENDING'};
   await route.fulfill({json:data});
  });
  await page.goto(origin+'/booking');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.getByLabel('Утас',{exact:true}).fill('99112233');await page.getByLabel('Нууц үг',{exact:true}).fill('test-booker-password');await page.locator('button[type=submit]').click();
  await page.getByLabel('Ирэх өдөр, цаг (Улаанбаатар)',{exact:true}).fill('2026-10-10T14:00');await page.getByLabel('Гарах өдөр',{exact:true}).fill('2026-10-12');await page.getByRole('button',{name:'Буудал хайх',exact:true}).click();await page.getByRole('heading',{name:'Туршилтын буудал',exact:true}).waitFor();
  await page.getByRole('button',{name:'Захиалах',exact:true}).click();await page.getByLabel('Огноо, нийт дүн, цуцлалтын нөхцөлийг шалгасан',{exact:true}).check();await page.getByRole('button',{name:'Захиалга үүсгэх',exact:true}).click();await page.locator('.result.error').waitFor();await page.getByRole('button',{name:'Захиалга үүсгэх',exact:true}).click();await page.getByRole('heading',{name:'booking-1',exact:true}).waitFor();
  const creates=requests.filter(r=>r.path==='/booker/hotels/hotel-1/bookings');assert.equal(creates.length,2);assert.deepEqual(creates[0].body,creates[1].body);assert.equal(creates[0].body.nights,2);assert.equal(creates[0].body.amount_mnt,undefined);
  await page.getByRole('button',{name:'Тулгах',exact:true}).click();await page.getByRole('heading',{name:'booking-1',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.equal(await page.locator('form:not([novalidate])').count(),0);
  await page.setViewportSize({width:320,height:650});await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/booking-mobile.png',fullPage:true});
  await page.goto(origin+'/platform/booking');await page.getByLabel('Буудлын код',{exact:true}).fill('hotel-1');await page.getByLabel('Имэйл',{exact:true}).fill('finance@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('test-platform-password');await page.getByLabel('MFA код',{exact:true}).fill('123456');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.getByRole('heading',{name:'batch-1',exact:true}).waitFor();await page.getByLabel('Хүлээн авагч ба дүнг шалгасан',{exact:true}).check();await page.getByRole('button',{name:'Шилжүүлэг илгээх',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('form[aria-busy=true]'));assert.equal(requests.filter(r=>r.path.endsWith('/execute')).length,1);
  await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'artifacts/booking-finance.png',fullPage:true});assert.deepEqual(problems,[]);
  fs.writeFileSync('artifacts/booking-requests.json',JSON.stringify(requests));console.log('Booking browser: search, login, review, safe retry, own bookings, finance dispatch, responsive and private storage passed.');
 }finally{await browser?.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
