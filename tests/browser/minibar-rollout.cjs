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
  const version={version_id:'v2',version_number:2,state:'PUBLISHED',items:[{product_id:'water',name:'Ус',unit:'ш',target_quantity:2}]};
  const parent={template_id:'standard',name:'Стандарт',status:'ACTIVE',revision:5,default_version_id:'v1'};
  const rooms=[0,1,2,3].map(n=>({room_id:'r'+n,number:'10'+n,category_name:'Стандарт',status:'ACTIVE',revision:4}));
  page.on('pageerror',e=>problems.push(e.message));
  await page.route('**/auth/**',r=>r.fulfill({json:new URL(r.request().url()).pathname==='/auth/login'?{access_token:'fake-token'}:{roles:['MANAGER']}}));
  await page.route('**/hotels/**',async r=>{
   const tail=new URL(r.request().url()).pathname.replace('/hotels/test-hotel/',''),body=r.request().postDataJSON(),method=r.request().method();let result={};
   if(tail.includes('/rollout/'))requests.push({tail,body,method});
   if(tail==='operations')result={roles:['MANAGER'],package_mnt:30000,mode:'LIVE',staff:[]};
   else if(tail==='rooms')result=rooms;
   else if(tail==='room-categories'||tail==='stays/active')result=[];
   else if(tail==='minibar/templates')result={items:[parent],next_after:null};
   else if(tail==='minibar/templates/standard/versions')result={...parent,items:[version],next_after:null};
   else if(tail==='minibar/templates/standard/versions/v2')result={...parent,version};
   else{
    const match=tail.match(/^minibar\/templates\/standard\/versions\/v2\/rollout\/(r\d)(\/preview)?$/);assert(match,tail);
    if(match[2]){
     if(match[1]==='r1'&&fail){fail=false;return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}
     result={room_id:match[1],room_number:rooms.find(x=>x.room_id===match[1]).number,room_revision:revision,eligible:match[1]!=='r0',code:match[1]==='r0'?'ROLLOUT_UNCHANGED':null,disposition:match[1]==='r2'?'SCHEDULE_AFTER_STAY':'READY_NOW'};
    }else{
     if(receipts.has(body.idempotency_key))return r.fulfill({status:201,json:receipts.get(body.idempotency_key)});
     if(conflict){conflict=false;revision++;return r.fulfill({status:409,json:{code:'REVISION_CONFLICT'}});}
     assert.equal(body.expected_room_revision,revision);assert(body.reason);result={request_id:'q'+match[1],state:'READY_FOR_RECONCILIATION',revision:1};receipts.set(body.idempotency_key,result);
     if(lost){lost=false;return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}
    }
   }
   await r.fulfill({status:body?201:200,json:result});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false'&&!document.querySelector('form[aria-busy="true"]'));
  await page.goto(origin+'/reception#templates');await page.getByLabel('Буудлын код').fill('test-hotel');await page.getByLabel('Имэйл',{exact:true}).fill('manager@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await ready();
  const open=async()=>{await page.getByRole('link',{name:'Минибарын загвар',exact:true}).click();await ready();await page.getByRole('button',{name:'Өрөөний хувилбар шинэчлэх'}).click();await page.getByRole('button',{name:'Шилжүүлэх нөхцөл шалгах'}).first().waitFor();};
  await page.getByRole('button',{name:'Хувилбаруудыг нээх'}).click();await ready();await page.getByRole('button',{name:'Бүрдлийг нээх'}).click();await ready();await page.getByRole('button',{name:'Өрөөний хувилбар шинэчлэх'}).click();
  await page.getByRole('button',{name:'Шилжүүлэх нөхцөл шалгах'}).nth(0).click();assert(await page.getByRole('button',{name:'Шилжүүлэх хүсэлт батлах'}).isDisabled());
  await page.getByRole('button',{name:'Шилжүүлэх нөхцөл шалгах'}).nth(1).click();await page.getByRole('button',{name:'Шилжүүлэх нөхцөлийг дахин ачаалах'}).click();await page.getByLabel('Шалтгаан',{exact:true}).waitFor();
  const fill=async()=>{await page.getByLabel('Шалтгаан',{exact:true}).fill('Шинэ бүрдэлд шилжүүлэх');await page.getByLabel('Зорилтот хувилбар болон өрөөний хоригийг ойлгосон').check();};
  const submit=()=>page.getByRole('button',{name:'Шилжүүлэх хүсэлт батлах'}).click();
  await submit();assert.equal(await page.evaluate(()=>document.activeElement.name),'reason');await fill();await submit();await page.locator('.result.error').waitFor();assert.match(await page.locator('.result.error').textContent(),/Мэдээлэл өөрчлөгджээ/);
  await page.locator('#refresh').click();await page.locator('#discard').waitFor({state:'visible'});await page.locator('#leave').click();await ready();await page.getByRole('button',{name:'Өрөөний хувилбар шинэчлэх'}).click();await page.getByRole('button',{name:'Шилжүүлэх нөхцөл шалгах'}).nth(1).click();await fill();
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/minibar-rollout-desktop.png',fullPage:true});await page.setViewportSize({width:320,height:760});await page.emulateMedia({reducedMotion:'reduce'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'artifacts/minibar-rollout-mobile.png',fullPage:true});
  await submit();await page.locator('.result.error').waitFor();await submit();await ready();
  for(const n of [2,3]){await open();await page.getByRole('button',{name:'Шилжүүлэх нөхцөл шалгах'}).nth(n).click();if(n===2)await page.getByText('Өмнөх байрлалт, төлбөр болон минибарын ажил дуусмагц тооллогын ажил үүснэ.').waitFor();await fill();await submit();await ready();}
  const commands=requests.filter(r=>r.body);assert.equal(commands.length,5);assert.equal(commands[1].body.idempotency_key,commands[2].body.idempotency_key);assert.notEqual(commands[0].body.idempotency_key,commands[1].body.idempotency_key);assert.equal(receipts.size,3);
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.deepEqual(problems,[]);
  fs.writeFileSync('artifacts/minibar-rollout-requests.json',JSON.stringify(requests));console.log('Minibar rollout browser: no-op disabled, preview retry, CAS reload, lost response, scheduled status, exact target and mobile passed.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
