const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');
 await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})}).catch(e=>{server.close();throw e;});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),origin=`http://127.0.0.1:${server.address().port}`;
  const requests=[],problems=[],receipts=new Map();let revision=4,fail=true,lost=true,conflict=true;
  const versions=[1,2].map(n=>({version_id:'v'+n,version_number:n,state:'PUBLISHED',items:[{product_id:'water',name:'Ус',unit:'ш',target_quantity:2}],published_at:'2026-09-09T00:00:00Z'}));
  const parent=()=>({template_id:'standard',name:'Стандарт',status:'ACTIVE',revision,default_version_id:'v1'});
  page.on('pageerror',e=>problems.push(e.message));
  await page.route('**/auth/**',r=>r.fulfill({json:new URL(r.request().url()).pathname==='/auth/login'?{access_token:'fake-token'}:{roles:['MANAGER']}}));
  await page.route('**/hotels/**',async r=>{
   const tail=new URL(r.request().url()).pathname.replace('/hotels/test-hotel/',''),body=r.request().postDataJSON(),method=r.request().method();let result={};
   if(tail.startsWith('minibar/'))requests.push({tail,body,method});
   if(tail==='operations')result={roles:['MANAGER'],package_mnt:30000,mode:'LIVE'};
   else if(tail==='minibar/templates')result={items:[parent()],next_after:null};
   else if(tail==='minibar/templates/standard/versions'){
    if(body){assert.equal(body.expected_revision,revision);const source=versions.find(v=>v.version_id===body.source_version_id);const v={...structuredClone(source),version_id:'v3',version_number:3,state:'DRAFT',published_at:null};versions.push(v);revision++;result={...parent(),version:v};}
    else result={...parent(),items:versions,next_after:null};
   }else{
    const match=tail.match(/^minibar\/templates\/standard\/versions\/(v\d+)(?:\/(archive-preview|archive|publish))?$/);assert(match,tail);
    const v=versions.find(v=>v.version_id===match[1]);
    if(match[2]==='archive-preview'){
     if(v.version_id==='v2'&&fail){fail=false;return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}
     result={revision,state:v.state,eligible:v.state==='PUBLISHED'&&v.version_id!=='v1',blockers:v.version_id==='v1'?[{kind:'DEFAULT',count:1}]:[],archive:v.state==='ARCHIVED'?{reason:'Шинэ бүрдэлд шилжсэн',recorded_at:'2026-09-09T03:00:00Z'}:null};
    }else if(match[2]==='archive'){
     if(receipts.has(body.idempotency_key))return r.fulfill({json:receipts.get(body.idempotency_key)});
     if(conflict){conflict=false;revision++;return r.fulfill({status:409,json:{code:'REVISION_CONFLICT'}});}
     assert.equal(body.expected_revision,revision);assert(body.reason);v.state='ARCHIVED';revision++;result={...parent(),version:structuredClone(v)};receipts.set(body.idempotency_key,result);
     if(lost){lost=false;return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}
    }else if(match[2]==='publish'){assert.equal(body.expected_revision,revision);v.state='PUBLISHED';v.published_at='2026-09-09T03:00:00Z';revision++;result={...parent(),version:v};}
    else result={...parent(),version:v};
   }
   await r.fulfill({json:result});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false'&&!document.querySelector('form[aria-busy="true"]'));
  await page.goto(origin+'/reception#templates');await page.getByLabel('Буудлын код').fill('test-hotel');await page.getByLabel('Имэйл',{exact:true}).fill('manager@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await ready();
  await page.getByRole('button',{name:'Хувилбаруудыг нээх'}).click();await ready();await page.getByRole('button',{name:'Бүрдлийг нээх'}).nth(0).click();await ready();
  await page.getByRole('button',{name:'Архивлах нөхцөлийг шалгах'}).click();await page.getByRole('table',{name:'Архивлахад саад болж буй хэрэглээ'}).waitFor();assert.equal(await page.getByRole('button',{name:'Хувилбарыг архивлах',exact:true}).count(),0);
  await page.getByRole('button',{name:'Хувилбарын жагсаалт',exact:true}).click();await ready();await page.getByRole('button',{name:'Бүрдлийг нээх'}).nth(1).click();await ready();
  await page.getByRole('button',{name:'Архивлах нөхцөлийг шалгах'}).click();await page.getByRole('button',{name:'Архивлах нөхцөлийг дахин ачаалах'}).click();await page.getByLabel('Шалтгаан',{exact:true}).waitFor();
  const submit=()=>page.getByRole('button',{name:'Хувилбарыг архивлах',exact:true}).click();
  await submit();assert.equal(await page.evaluate(()=>document.activeElement.name),'reason');await page.getByLabel('Шалтгаан',{exact:true}).fill('Шинэ бүрдэлд шилжсэн');await submit();assert.equal(await page.evaluate(()=>document.activeElement.name),'reviewed');await page.getByLabel('Архивлах нөхцөл, үр дүнг ойлгосон').check();await submit();await page.locator('.result.error').waitFor();assert.match(await page.locator('.result.error').textContent(),/Мэдээлэл өөрчлөгджээ/);
  await page.locator('#refresh').click();await page.locator('#discard').waitFor({state:'visible'});await page.locator('#leave').click();await ready();await page.getByRole('button',{name:'Архивлах нөхцөлийг шалгах'}).click();await page.getByLabel('Шалтгаан',{exact:true}).fill('Шинэ бүрдэлд шилжсэн');await page.getByLabel('Архивлах нөхцөл, үр дүнг ойлгосон').check();
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/minibar-archive-desktop.png',fullPage:true});await page.setViewportSize({width:320,height:760});await page.emulateMedia({reducedMotion:'reduce'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'artifacts/minibar-archive-mobile.png',fullPage:true});
  await submit();await page.locator('.result.error').waitFor();await submit();await ready();await page.getByRole('button',{name:'Архивын бүртгэл'}).waitFor();
  const archiveRequests=requests.filter(r=>r.tail.endsWith('/archive'));assert.equal(archiveRequests[1].body.idempotency_key,archiveRequests[2].body.idempotency_key);assert.notEqual(archiveRequests[0].body.idempotency_key,archiveRequests[1].body.idempotency_key);
  for(const name of ['Үндсэн хувилбар болгох','Өрөөнд тохируулах хүсэлт','Хувилбарыг нийтлэх'])assert.equal(await page.getByRole('button',{name,exact:true}).count(),0);
  await page.getByRole('button',{name:'Архивын бүртгэл'}).click();await page.getByText('Шинэ бүрдэлд шилжсэн',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Ноорог хуулбар үүсгэх',exact:true}).click();await ready();await page.getByLabel('Бүтээгдэхүүн болон тоог шалгасан').check();await page.getByRole('button',{name:'Хувилбарыг нийтлэх',exact:true}).click();await ready();await page.getByRole('button',{name:'Архивлах нөхцөлийг шалгах'}).click();await page.getByLabel('Шалтгаан',{exact:true}).fill('Давхардсан хуулбар');await page.getByLabel('Архивлах нөхцөл, үр дүнг ойлгосон').check();await submit();await ready();
  assert.equal(versions[0].state,'PUBLISHED');assert.equal(versions[1].state,'ARCHIVED');assert.equal(versions[2].state,'ARCHIVED');assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.deepEqual(problems,[]);
  fs.writeFileSync('artifacts/minibar-archive-requests.json',JSON.stringify(requests));console.log('Minibar archive browser: blockers, load retry, reason/ack, CAS recovery, lost-response retry, terminal actions, clone and mobile passed.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
