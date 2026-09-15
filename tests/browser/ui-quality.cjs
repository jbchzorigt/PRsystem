const {chromium}=require('playwright');
const {default:AxeBuilder}=require('@axe-core/playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):req.url.startsWith('/staff/')?'staff.html':'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');
 await new Promise(r=>server.on('listening',r));
 let browser;
 try{
  browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})});
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),origin=`http://127.0.0.1:${server.address().port}`,reports=[],errors=[];
  let loginCalls=0,releaseLogin,roomFailure=false,filterCalls=0;
  const room={room_id:'r',number:'101',floor:'1',category_id:'c',category_name:'Стандарт',status:'ACTIVE',cleaning_state:'CLEAN',revision:1,minibar_mode:'OFF',tariffs:{}};
  const overview={account_id:'worker',roles:['RECEPTION'],package_mnt:20000,mode:'MOCK_CASH_LEDGER',staff:[],drawers:[],shifts:[],funding:[],custodies:[],qrs:[],inspections:[],cleaning:[]};
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/auth/**',async r=>{
   const u=new URL(r.request().url());
   if(u.pathname==='/auth/login'){loginCalls++;if(loginCalls===1)await new Promise(resolve=>{releaseLogin=resolve;});await r.fulfill({json:{access_token:'synthetic-ui-session'}});}
   else await r.fulfill({json:{roles:['RECEPTION']}});
  });
  await page.route('**/hotels/**',async r=>{
   const p=new URL(r.request().url()).pathname.split('/').slice(3).join('/');
   if(p==='rooms'&&roomFailure){await r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});return;}
   const data=p==='operations'?overview:p==='rooms'?[room]:p==='room-categories'?[{category_id:'c',name:'Стандарт',status:'ACTIVE'}]:[];
   await r.fulfill({json:data});
  });
  const audit=async name=>{
   const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
   reports.push({name,violations:result.violations,incomplete:result.incomplete.map(r=>({id:r.id,nodes:r.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))});
   assert.deepEqual(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),[],name);
  };
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')!=='true'&&!document.querySelector('form[aria-busy="true"]'));
  const reflow=async name=>{for(const width of [1440,640,320]){await page.setViewportSize({width,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' '+width);}await audit(name+' 320px');};
  await page.goto(origin+'/reception');await audit('staff login');
  await page.getByLabel('Буудлын код').fill('hotel');await page.getByLabel('Имэйл',{exact:true}).fill('worker@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Synthetic password 2026');
  await page.locator('[name=password]').dispatchEvent('compositionstart');
  await page.locator('form').evaluate(f=>f.requestSubmit());assert.equal(loginCalls,0,'IME must not submit');
  await page.locator('[name=password]').dispatchEvent('compositionend');
  const submit=page.getByRole('button',{name:'Нэвтрэх',exact:true}),before=await submit.boundingBox();await submit.click();
  await page.waitForFunction(()=>document.querySelector('form[aria-busy="true"]'));
  assert.equal(await page.locator('form input:enabled').count(),0,'submitted values stay locked');
  const during=await submit.boundingBox();assert.equal(before.width,during.width);assert.equal(before.height,during.height);
  await page.locator('form').evaluate(f=>f.requestSubmit());assert.equal(loginCalls,1);
  releaseLogin();await ready();await page.getByRole('button',{name:'Шууд ирсэн зочин бүртгэх',exact:true}).waitFor();
  await audit('reception empty stays');
  const start=page.getByRole('button',{name:'Шууд ирсэн зочин бүртгэх',exact:true});await start.click();
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Бүртгэлийн төрөл');
  await page.getByRole('button',{name:'Маягтыг хаах',exact:true}).click();assert.equal(await start.evaluate(e=>e===document.activeElement),true);
  await start.click();const select=page.getByLabel('Баримтын төрөл');await select.focus();await page.keyboard.press('Alt+ArrowDown');await page.keyboard.press('Escape');assert.equal(await select.evaluate(e=>e===document.activeElement),true);
  await page.getByRole('button',{name:'Зочны мэдээлэл оруулах',exact:true}).click();await ready();
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Шууд ирсэн зочин бүртгэх');
  assert.equal(await page.getByRole('group',{name:'Зочны мэдээлэл',exact:true}).count(),1);
  const form=page.getByRole('form',{name:'Шууд ирсэн зочин бүртгэх',exact:true});
  await form.getByRole('button',{name:'Зочны бүртгэл баталгаажуулах',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.activeElement.name),'family_name');await audit('check-in validation');
  await page.getByLabel('Өмнө ирсэн цагийн шалтгаан').fill('Урт тайлбар. '.repeat(100));
  const expand=page.getByRole('button',{name:'Бичих талбарыг томруулах'});await expand.click();assert.equal(await page.getByLabel('Өмнө ирсэн цагийн шалтгаан').getAttribute('rows'),'10');
  await reflow('check-in grouped form');
  await page.getByRole('link',{name:'Өрөөнүүд',exact:true}).click();await page.getByRole('dialog').waitFor();await audit('discard dialog');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'keep');await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);
  await page.getByRole('link',{name:'Өрөөнүүд',exact:true}).click();await page.getByRole('button',{name:'Маягтыг орхих',exact:true}).click();await ready();
  roomFailure=true;await page.getByRole('button',{name:'Мэдээлэл шинэчлэх',exact:true}).click();await page.getByRole('button',{name:'Дахин ачаалах',exact:true}).waitFor();await audit('read failure');
  roomFailure=false;await page.getByRole('button',{name:'Дахин ачаалах',exact:true}).click();await ready();await reflow('rooms');
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/ux-rooms-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'artifacts/ux-rooms-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'Гарах',exact:true}).click();await page.getByRole('heading',{name:'Ажилтнаар нэвтрэх',exact:true}).waitFor();assert.match(await page.title(),/Ажилтнаар нэвтрэх/);
  await page.route('**/platform/**',async r=>{
   const u=new URL(r.request().url());if(u.pathname.includes('/auth/')){await r.fulfill({json:{access_token:'synthetic-platform-session'}});return;}
   assert.equal(u.pathname,'/platform/operation');filterCalls++;
   await r.fulfill({json:{as_of:'2026-09-15T01:00:00Z',permissions:['OPERATION_READ'],total:0,statuses:{ACTIVE:0},packages:{20000:0},not_activated:0,sms_month:{SENT:0},items:[],next_after:null,mode:'MOCK_ONLY'}});
  });
  await page.goto(origin+'/operation');await page.getByLabel('Имэйл',{exact:true}).fill('operator@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Synthetic password 2026');await page.getByLabel('MFA код',{exact:true}).fill('123456');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await ready();
  await page.getByLabel('Дуусах хүртэлх хоног').fill('366');const calls=filterCalls;await page.getByRole('button',{name:'Шүүх',exact:true}).click();assert.equal(filterCalls,calls);assert.match(await page.locator('[name=expires_within_days]').getAttribute('aria-describedby'),/error/);assert.match(await page.locator('.field .error').allTextContents().then(x=>x.join(' ')),/365/);
  await page.getByLabel('Дуусах хүртэлх хоног').fill('30');await page.getByLabel('Буудлын нэр').fill('Улаанбаатар');await page.getByRole('button',{name:'Шүүх',exact:true}).click();await ready();
  await page.getByRole('button',{name:'Хайлтыг цэвэрлэх',exact:true}).click();await ready();assert.equal(await page.getByLabel('Буудлын нэр').inputValue(),'');assert.equal(await page.getByLabel('Дуусах хүртэлх хоног').inputValue(),'30');
  await page.waitForFunction(()=>document.activeElement.name==='query');await reflow('operation no results');
  const region=page.getByRole('region',{name:'Үйлчилгээний эрхийн бүртгэл',exact:true});await region.focus();await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.querySelector('.operation-subscriptions').scrollLeft>0);
  await page.emulateMedia({reducedMotion:'reduce',forcedColors:'active'});await audit('operation forced colors');await page.emulateMedia({forcedColors:'none'});
  await page.screenshot({path:'artifacts/ux-operation-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'artifacts/ux-operation-desktop.png',fullPage:true});
  await page.getByLabel('Буудлын нэр').fill('Хадгалаагүй шүүлт');await page.locator('summary').click();await page.getByLabel('Шинэ MFA код',{exact:true}).fill('123456');await page.getByRole('button',{name:'Эрх баталгаажуулах',exact:true}).click();await ready();await page.getByRole('button',{name:'Нүүр',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'Үргэлжлүүлэн засах',exact:true}).click();assert.equal(await page.getByLabel('Буудлын нэр').inputValue(),'Хадгалаагүй шүүлт');await page.getByRole('button',{name:'Нүүр',exact:true}).click();await page.getByRole('button',{name:'Маягтыг орхих',exact:true}).click();await ready();
  await page.goto(origin+'/booking');await audit('booking search');await reflow('booking search');
  for(const route of ['activate','accept','restaurant-accept','reset']){await page.goto(origin+'/staff/'+route+'#token='+'a'.repeat(32)+'.'+'b'.repeat(64));await audit('staff link '+route);}
  for(const route of ['/restaurant','/subscription/contact','/guest/entry']){await page.goto(origin+route);await audit('entry '+route);}
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  fs.writeFileSync('artifacts/ui-accessibility.json',JSON.stringify(reports,null,2));
  console.log(`UI quality: ${reports.length} WCAG scans with zero violations; IME, pending lock, stable buttons, focus, grouped form, validation, retry, native select, responsive tables, filter clearing, reduced motion and privacy passed.`);
 }finally{if(browser)await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
