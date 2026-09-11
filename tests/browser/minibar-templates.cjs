const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');
 await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})}).catch(e=>{server.close();throw e;});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),origin=`http://127.0.0.1:${server.address().port}`;
  const requests=[],problems=[];let template=null,versions=[],lost=true,pickerFail=true,conflict=true,role='MANAGER',packageMnt=30000;
  const room={room_id:'room-101',number:'101',category_id:'standard',category_name:'Стандарт',category_status:'ACTIVE',status:'ACTIVE',cleaning_state:'CLEAN',minibar_mode:'OFF',revision:1,pending_minibar_change:false};let configuration=null,configFail=true,configLost=true;const configHistory=[];
  page.on('pageerror',e=>problems.push(e.message));
  await page.route('**/auth/**',r=>r.fulfill({json:new URL(r.request().url()).pathname==='/auth/login'?{access_token:'fake-token'}:{roles:[role]}}));
  await page.route('**/hotels/**',async r=>{
   const u=new URL(r.request().url()),tail=u.pathname.replace('/hotels/test-hotel/',''),body=r.request().postDataJSON(),method=r.request().method();
   if(tail.startsWith('minibar/')||tail.includes('minibar-configuration'))requests.push({tail,body,method});
   if(body)await new Promise(resolve=>setTimeout(resolve,100));let result={};
   if(tail==='operations')result={roles:[role],package_mnt:packageMnt,mode:'LIVE',hotel_settings:[10000,80000,'12:00',1],deposit_settings:[60000,1],funding:[]};
   else if(tail==='rooms')result=[room];
   else if(['room-categories','stays/active','bookings'].includes(tail))result=[];
   else if(tail==='rooms/room-101/minibar-configuration/requests'){
    if(!configuration){assert.equal(body.expected_room_revision,room.revision);configuration={request_id:'config-'+(configHistory.length+1),revision:1,state:'READY_FOR_RECONCILIATION',target_mode:body.target_mode,reason:body.reason,recorded_at:'2026-09-09T01:00:00Z',target_snapshot:body.target_mode==='ON'?{template_name:template.name,version_number:2,items:versions[1].items}:{items:[]}};configHistory.push(configuration);room.pending_minibar_change=true;room.revision++;}
    if(configLost){configLost=false;await r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});return;}result=configuration;
   }else if(tail==='rooms/room-101/minibar-configuration'){
    if(configFail){configFail=false;await r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});return;}
    result={room_number:'101',current:{mode:room.minibar_mode,room_revision:room.revision},pending:configuration,items:configHistory,next_after:null};
   }else if(tail.match(/^minibar\/configuration-requests\/config-\d+\/cancel$/)){
    assert.equal(body.expected_revision,configuration.revision);configuration.state='CANCELLED';configuration.cancel_reason=body.reason;configuration.revision++;result=configuration;configuration=null;room.pending_minibar_change=false;room.revision++;
   }
   else if(tail==='minibar/products'){
    if(pickerFail){pickerFail=false;await r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});return;}
    result={items:[{product_id:'water',name:'Ус',unit:'ширхэг',status:'ACTIVE'}],next_after:null};
   }else if(tail==='minibar/templates'){
    if(body){template||={template_id:'standard',name:body.name,status:'ACTIVE',revision:1,default_version_id:null};if(lost){lost=false;await r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});return;}result=template;}
    else result={items:template?[template]:[],next_after:null};
   }else if(tail==='minibar/templates/standard/versions'){
    if(body){assert.equal(body.expected_revision,template.revision);const source=versions.find(v=>v.version_id===body.source_version_id),v={version_id:'v'+(versions.length+1),version_number:versions.length+1,state:'DRAFT',items:source?structuredClone(source.items):[],published_at:null};versions.push(v);template.revision++;result={...template,version:v};}
    else result={...template,items:versions,next_after:null};
   }else{
    const match=tail.match(/minibar\/templates\/standard\/versions\/(v\d+)(?:\/(publish|default))?$/);
    assert(match,tail);const v=versions.find(v=>v.version_id===match[1]);
    if(body){
     if(method==='PUT'&&conflict){conflict=false;template.revision++;await r.fulfill({status:409,json:{code:'REVISION_CONFLICT'}});return;}
     assert.equal(body.expected_revision,template.revision);
     if(method==='PUT'){v.items=body.items.map(i=>({...i,name:'Ус',unit:'ширхэг',product_status:'ACTIVE'}));}
     else if(match[2]==='publish'){v.state='PUBLISHED';v.published_at='2026-09-09T01:00:00Z';template.default_version_id||=v.version_id;}
     else if(match[2]==='default')template.default_version_id=v.version_id;
     template.revision++;
    }
    result={...template,version:v};
   }
   await r.fulfill({json:result});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false'&&!document.querySelector('form[aria-busy="true"]'));
  const login=async()=>{await page.goto('about:blank');await page.goto(origin+'/reception#templates');await page.getByLabel('Буудлын код').fill('test-hotel');await page.getByLabel('Имэйл',{exact:true}).fill('manager@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await ready();};
  await login();assert.match(await page.locator('#content').textContent(),/загвар бүртгэлгүй/);
  await page.getByRole('button',{name:'Загвар үүсгэх',exact:true}).click();let f=page.locator('form').filter({has:page.getByRole('heading',{name:'Шинэ минибарын загвар'})});
  await f.getByRole('button',{name:'Загвар үүсгэх',exact:true}).click();assert.equal(await page.evaluate(()=>document.activeElement.name),'name');
  await page.getByLabel('Загварын нэр').fill('Стандарт');await f.getByRole('button',{name:'Загвар үүсгэх',exact:true}).click();await f.locator('.result.error').waitFor();assert.equal(await page.getByLabel('Загварын нэр').inputValue(),'Стандарт');
  await f.getByRole('button',{name:'Загвар үүсгэх',exact:true}).click();await page.getByRole('button',{name:'Хувилбаруудыг нээх'}).waitFor();
  assert.equal(requests.filter(r=>r.tail==='minibar/templates'&&r.body)[0].body.idempotency_key,requests.filter(r=>r.tail==='minibar/templates'&&r.body)[1].body.idempotency_key);
  await page.getByRole('button',{name:'Хувилбаруудыг нээх'}).click();await page.getByRole('button',{name:'Ноорог үүсгэх',exact:true}).click();await ready();await page.getByRole('button',{name:'Бүтээгдэхүүн нэмэх',exact:true}).waitFor();
  await page.getByRole('button',{name:'Бүтээгдэхүүн нэмэх',exact:true}).click();await page.getByRole('button',{name:'Бүтээгдэхүүнийг дахин ачаалах'}).click();
  await page.getByLabel('Нэмэх бүтээгдэхүүн').focus();await page.keyboard.press('Space');await page.keyboard.press('Escape');
  await page.getByLabel('Байлгах тоо').fill('2');await page.getByRole('link',{name:'Агуулах',exact:true}).click();await page.locator('#discard').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>document.activeElement.id),'keep');await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Бүрдэлд нэмэх',exact:true}).click();await page.locator('.result.error').waitFor();assert.match(await page.locator('.result.error').textContent(),/Мэдээлэл өөрчлөгджээ/);
  await page.locator('#refresh').click();await page.locator('#discard').waitFor({state:'visible'});await page.locator('#leave').click();await ready();
  await page.getByRole('button',{name:'Бүтээгдэхүүн нэмэх',exact:true}).click();await page.getByLabel('Байлгах тоо').fill('2');await page.getByRole('button',{name:'Бүрдэлд нэмэх',exact:true}).click();await ready();await page.getByText('Ноорог бүрдэлд бүтээгдэхүүн нэмэгдлээ.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Хувилбарыг нийтлэх',exact:true}).click();assert.equal(await page.evaluate(()=>document.activeElement.name),'reviewed');
  await page.getByLabel('Бүтээгдэхүүн болон тоог шалгасан').check();await page.getByRole('button',{name:'Хувилбарыг нийтлэх',exact:true}).click();await ready();assert.match(await page.locator('#content').textContent(),/Нийтэлсэн · Үндсэн хувилбар/);assert.equal(await page.getByRole('button',{name:'Тоо өөрчлөх / хасах'}).count(),0);
  await page.getByRole('button',{name:'Ноорог хуулбар үүсгэх',exact:true}).click();await ready();await page.getByRole('button',{name:'Тоо өөрчлөх / хасах',exact:true}).click();await page.getByLabel('Шинэ тоо (0 бол бүрдлээс хасна)').fill('5');await page.getByRole('button',{name:'Бүрдлийг хадгалах',exact:true}).click();await ready();await page.getByText('Ноорог бүрдэл хадгалагдлаа.',{exact:true}).waitFor();
  await page.getByLabel('Бүтээгдэхүүн болон тоог шалгасан').check();await page.getByRole('button',{name:'Хувилбарыг нийтлэх',exact:true}).click();await ready();await page.getByRole('button',{name:'Үндсэн хувилбар болгох',exact:true}).waitFor();assert.equal(template.default_version_id,'v1');
  await page.getByRole('button',{name:'Үндсэн хувилбар болгох',exact:true}).click();await ready();await page.getByText('Үндсэн хувилбар солигдлоо.',{exact:true}).waitFor();assert.equal(template.default_version_id,'v2');assert.equal(versions[0].items[0].target_quantity,2);
  await page.getByRole('button',{name:'Өрөөнд тохируулах хүсэлт',exact:true}).click();
  await page.getByLabel('Тохируулах өрөө').waitFor();await page.getByLabel('Шалтгаан',{exact:true}).fill('101 өрөөний шинэ бүрдэл');
  await page.getByRole('button',{name:'Тохиргооны хүсэлт илгээх',exact:true}).click();assert.equal(await page.evaluate(()=>document.activeElement.name),'reviewed');
  await page.getByLabel('Өрөөний шинэ бүртгэл түр хаагдахыг ойлгосон').check();await page.getByRole('button',{name:'Тохиргооны хүсэлт илгээх',exact:true}).click();await page.locator('.result.error').waitFor();
  await page.getByRole('button',{name:'Тохиргооны хүсэлт илгээх',exact:true}).click();await ready();await page.getByRole('button',{name:'Минибарын тохиргоо',exact:true}).waitFor();
  const configRequests=requests.filter(r=>r.tail.endsWith('/minibar-configuration/requests'));assert.equal(configRequests[0].body.idempotency_key,configRequests[1].body.idempotency_key);assert.equal(configRequests[0].body.target_version_id,'v2');
  assert.match(await page.locator('#content').textContent(),/Минибарын тохиргоо хүлээгдэж буй/);assert.equal(room.minibar_mode,'OFF');
  await page.getByRole('button',{name:'Минибарын тохиргоо',exact:true}).click();await page.getByRole('button',{name:'Тохиргоог дахин ачаалах',exact:true}).click();await page.getByLabel('Шалтгаан',{exact:true}).fill('Төлөвлөгөө өөрчлөгдсөн');
  await page.getByRole('button',{name:'Хүсэлтийг цуцлах',exact:true}).click();await ready();assert.equal(configuration,null);assert.equal(room.pending_minibar_change,false);
  room.minibar_mode='MOCK_ON';await page.getByRole('button',{name:'Минибарын тохиргоо',exact:true}).click();await page.getByLabel('Шалтгаан',{exact:true}).fill('Минибарыг зогсоох');await page.getByLabel('Өрөөний шинэ бүртгэл түр хаагдахыг ойлгосон').check();await page.getByRole('button',{name:'Унтраах хүсэлт илгээх',exact:true}).click();await ready();assert.equal(configuration.target_mode,'OFF');assert.equal(room.minibar_mode,'MOCK_ON');
  await page.getByRole('button',{name:'Минибарын тохиргоо',exact:true}).click();await page.getByRole('heading',{name:'Хүлээгдэж буй хүсэлт',exact:true}).waitFor();
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/minibar-templates-desktop.png',fullPage:true});await page.setViewportSize({width:320,height:760});await page.emulateMedia({reducedMotion:'reduce'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'artifacts/minibar-templates-mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.equal(await page.locator('form:not([novalidate])').count(),0);fs.writeFileSync('artifacts/minibar-template-requests.json',JSON.stringify(requests));
  role='RECEPTION';await login();await page.getByRole('link',{name:'Өрөөнүүд',exact:true}).click();await ready();assert.equal(await page.getByRole('button',{name:'Зочин бүртгэх',exact:true}).count(),0);await page.getByRole('button',{name:'Минибарын тохиргоо',exact:true}).click();await page.getByRole('heading',{name:'Хүлээгдэж буй хүсэлт',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Хүсэлтийг цуцлах',exact:true}).count(),0);assert.equal(await page.getByRole('link',{name:'Минибарын загвар',exact:true}).count(),0);role='MANAGER_PLUS';packageMnt=25000;await login();assert.equal(await page.getByRole('link',{name:'Минибарын загвар',exact:true}).count(),0);assert.deepEqual(problems,[]);
  console.log('Minibar template browser: author, clone, publish, default, room request/block/cancel, retry, conflict, permission, keyboard and mobile passed.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
