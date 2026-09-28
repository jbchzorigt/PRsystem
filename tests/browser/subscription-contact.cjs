const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})});
 try{
  const page=await browser.newPage({viewport:{width:320,height:760}}),requests=[],errors=[];let pending=null,completed=false;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/auth/**',r=>r.fulfill({json:{access_token:'mock-primary-contact-token'}}));
  await page.route('**/hotels/**',async r=>{
   const p=new URL(r.request().url()).pathname,body=r.request().postDataJSON(),method=r.request().method();if(body)requests.push({path:p,body,method});let result={};
   if(p.endsWith('/subscription/contact'))result={phone:completed?'+976****33':'+976****11',revision:completed?1:0,pending,available:true};
   else if(p.endsWith('/contact/changes')){assert.equal(body.new_phone,'88112233');assert.equal(typeof body.password,'string');pending={request_id:'change',old_phone:'+976****11',new_phone:'+976****33',exception_approved:false,proofs:[]};result={request_id:'change',state:'OPEN'};}
   else if(p.endsWith('/challenge')){const side=p.includes('/OLD/')?'OLD':'NEW';pending.proofs.push({side,expires_at:'2026-09-14T02:00:00Z',verified:false});result={challenge_id:side,state:'QUEUED'};}
   else if(p.endsWith('/verify')){const side=p.includes('/OLD/')?'OLD':'NEW';assert.equal(body.code,'123456');pending.proofs.find(i=>i.side===side).verified=true;result={state:'VERIFIED'};}
   else if(p.endsWith('/complete')){assert.equal(body.reviewed,true);assert.equal(pending.proofs.filter(i=>i.verified).length,2);completed=true;pending=null;result={state:'APPLIED'};}
   else throw Error('Unexpected route '+p);
   await r.fulfill({json:result});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')!=='true'&&!document.querySelector('form[aria-busy="true"]'));
  await page.goto(`http://127.0.0.1:${server.address().port}/subscription/contact`);await page.getByLabel('Буудлын код').fill('hotel');await page.getByLabel('Имэйл',{exact:true}).fill('primary@example.test');await page.getByLabel('Нууц үг',{exact:true}).fill('Mock Password 2026');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await ready();
  await page.getByLabel('Шинэ утас',{exact:true}).fill('88112233');await page.getByLabel('Нууц үгээр дахин батлах').fill('Mock Password 2026');await page.getByRole('button',{name:'Утас солих хүсэлт үүсгэх',exact:true}).click();await ready();
  for(const label of ['Хуучин дугаар','Шинэ дугаар']){
   let f=page.locator('form').filter({has:page.getByRole('heading',{name:label+' руу код хүсэх',exact:true})});await f.getByRole('button',{name:'Код илгээх',exact:true}).click();await ready();
   f=page.locator('form').filter({has:page.getByRole('heading',{name:label+' баталгаажуулах',exact:true})});await f.getByLabel(label+'ын код').fill('123456');await f.getByRole('button',{name:'Код батлах',exact:true}).click();await ready();
  }
  fs.mkdirSync('artifacts',{recursive:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'artifacts/subscription-contact-mobile.png',fullPage:true});
  await page.getByLabel('Хуучин ба шинэ дугаарын баталгааг бүрдүүлсэн').check();await page.getByRole('button',{name:'Утасны өөрчлөлтийг батлах',exact:true}).click();await ready();assert(completed);assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  fs.writeFileSync('artifacts/subscription-contact-requests.json',JSON.stringify(requests));console.log('Subscription contact browser: primary login, reauthentication, separate old/new proofs, atomic confirmation and mobile passed.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
