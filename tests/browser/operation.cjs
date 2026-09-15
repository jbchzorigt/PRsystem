const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),origin=`http://127.0.0.1:${server.address().port}`,requests=[],errors=[],receipts=new Map();let draft=0,queued=false,cancelled=false,sendLost=true;
  const permissions=['OPERATION_READ','SUBSCRIPTION_REMINDER_SEND','SUBSCRIPTION_PASSWORD_RESET_INITIATE','SUBSCRIPTION_EBARIMT_RETRY','SUBSCRIPTION_PAYMENT_RECONCILE'];
  const hotel={tenant_id:'hotel',name:'Хөх тэнгэр',owner_kind:'COMPANY',address:'Улаанбаатар',email:'o***@example.test',phone:'+976****33',package_mnt:30000,months:3,starts_at:'2026-09-01T00:00:00Z',expires_at:'2026-12-01T00:00:00Z',days_left:78,status:'ACTIVE',underlying_status:'ACTIVE',suspended:false};
  const quote={mode:'MOCK_ONLY',recipient_count:1,total_segments:1,estimated_cost_mnt:0};
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/platform/**',async r=>{
   const u=new URL(r.request().url()),body=r.request().postDataJSON(),method=r.request().method(),p=u.pathname;
   if(p.startsWith('/platform/auth/')){await r.fulfill({json:p.endsWith('login')?{access_token:'mock-platform-token-for-browser'}:{state:'VERIFIED'}});return;}
   if(body)requests.push({path:p,body,method});let result={};
   if(body&&receipts.has(body.idempotency_key)){await r.fulfill({json:receipts.get(body.idempotency_key)});return;}
   if(p==='/platform/operation')result={as_of:'2026-09-14T01:00:00Z',permissions,total:1,statuses:{ACTIVE:1,EXPIRING:0,GRACE:0,EXPIRED:0,SUSPENDED:0},packages:{20000:0,25000:0,30000:1},not_activated:0,sms_month:{SENT:0},items:[hotel],next_after:null,sms_available:true,mode:'MOCK_ONLY'};
   else if(p==='/platform/operation/sms/preview'){draft++;assert.equal(body.filters.tenant_ids,undefined);result={draft_id:'draft-'+draft,message:body.message,selected_hotels:1,deduplicated:0,excluded_invalid_phone:0,quote,recipients:[{phone:'+976****33',hotel_count:1}],expires_at:'2026-09-14T01:10:00Z'};}
   else if(p==='/platform/operation/sms/draft-2/send'){assert.equal(body.reviewed,true);queued=true;result={state:'QUEUED',job_id:'job',recipient_count:1,quote};receipts.set(body.idempotency_key,result);if(sendLost){sendLost=false;await r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});return;}}
   else if(p==='/platform/operation/sms')result={items:queued?[{job_id:'job',created_at:'2026-09-14T01:00:00Z',message:'Шинэ сануулга',quote,recipients:[{recipient_id:'recipient',phone:'+976****33',state:cancelled?'CANCELLED':'QUEUED',attempts:0,revision:0}]}]:[],next_after:null};
   else if(p==='/platform/operation/sms/recipients/recipient/cancel'){assert.equal(body.expected_revision,0);cancelled=true;result={state:'CANCELLED'};}
   else if(p==='/platform/operation/hotels/hotel/password-reset'){assert.equal(body.reviewed,true);assert.equal(body.email,undefined);result={state:'QUEUED',email:'o***@example.test'};}
   else if(p==='/platform/operation/billing')result={items:[{source_kind:'ONBOARDING',source_id:'attempt',name:hotel.name,amount_mnt:30000,paid:true,state:'PAID'}],jobs:[],failed_provisioning:[],next_after:null,ebarimt_available:true};
   else if(p==='/platform/operation/billing/ebarimt'){assert.equal(body.source_id,'attempt');assert.equal(body.email,undefined);assert.equal(body.amount_mnt,undefined);result={state:'QUEUED',job_id:'receipt'};}
   else throw Error('Unexpected route '+p);
   if(body)receipts.set(body.idempotency_key,structuredClone(result));await r.fulfill({json:result});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')!=='true'&&!document.querySelector('form[aria-busy="true"]'));
  await page.goto(origin+'/operation');await page.getByLabel('Имэйл',{exact:true}).fill('operation@example.test');await page.getByLabel('Нууц үг',{exact:true}).fill('Mock Password 2026');await page.getByLabel('MFA код',{exact:true}).fill('123456');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await ready();await page.getByRole('button',{name:'Шүүсэн буудлуудад сануулах',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Буудлын код',exact:true}).count(),0);
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/operation-dashboard-desktop.png',fullPage:true});await page.setViewportSize({width:320,height:760});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'artifacts/operation-dashboard-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'Шүүсэн буудлуудад сануулах',exact:true}).click();await page.getByLabel('Мессеж · 1–300 тэмдэгт').fill('Эхний сануулга');await page.getByRole('button',{name:'Урьдчилан харах',exact:true}).click();await ready();await page.getByRole('button',{name:'SMS дараалалд оруулах',exact:true}).waitFor();
  await page.getByLabel('Мессеж · 1–300 тэмдэгт').fill('Шинэ сануулга');assert.equal(await page.getByRole('button',{name:'SMS дараалалд оруулах',exact:true}).count(),0);
  await page.getByRole('button',{name:'Урьдчилан харах',exact:true}).click();await ready();await page.getByLabel('Хүлээн авагч, текст ба зардлыг шалгасан').check();await page.getByRole('button',{name:'SMS дараалалд оруулах',exact:true}).click();await page.locator('.result.error').waitFor();await page.getByRole('button',{name:'SMS дараалалд оруулах',exact:true}).click();await ready();await page.getByRole('button',{name:'SMS цуцлах',exact:true}).click();await ready();assert(cancelled);
  await page.getByRole('button',{name:'Хяналтын самбар',exact:true}).click();await ready();await page.getByRole('button',{name:'Дэлгэрэнгүй',exact:true}).click();await page.getByLabel('Бүртгэлтэй үндсэн имэйл рүү холбоос илгээхийг баталж байна').check();await page.getByRole('button',{name:'Сэргээх холбоос хүсэх',exact:true}).click();await ready();
  await page.getByRole('button',{name:'Жагсаалт руу',exact:true}).click();await ready();await page.getByRole('button',{name:'Төлбөр ба идэвхжүүлэлт',exact:true}).click();await ready();const f=page.locator('form').filter({has:page.getByRole('heading',{name:'eBarimt баримтын ажил',exact:true})});await f.getByLabel('Шалтгаан').fill('Туршилтын баримтыг шалгах');await f.getByRole('button',{name:'Баримтын ажил дараалалд оруулах',exact:true}).click();await ready();
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);const sends=requests.filter(r=>r.path.endsWith('/send'));assert.equal(sends.length,2);assert.equal(sends[0].body.idempotency_key,sends[1].body.idempotency_key);
  fs.writeFileSync('artifacts/operation-requests.json',JSON.stringify(requests));console.log('Operation browser: realm login, dashboard, responsive tables, preview invalidation, idempotent send, cancellation, canonical reset and billing passed.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
