const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');
 await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}:{})}).catch(e=>{server.close();throw e;});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),origin=`http://127.0.0.1:${server.address().port}`;
  const requests=[],problems=[],receipts=new Map();let lost=true,conflict=true,cancelled=false,historyFail=true;
  const version={version_id:'v2',version_number:2,state:'PUBLISHED',items:[{product_id:'water',name:'Ус',unit:'ш',target_quantity:2}]};
  const parent={template_id:'standard',name:'Стандарт',status:'ACTIVE',revision:5,default_version_id:'v1'};
  const rooms=Array.from({length:101},(_,n)=>({room_id:'r'+n,number:String(100+n),category_name:'Стандарт',status:'ACTIVE',revision:4}));
  const batch=(id='b1')=>{const retry=id==='b2',items=retry?[{room_id:'r1',room_number:'101',state:'READY_FOR_RECONCILIATION',revision:1}]:[{room_id:'r0',room_number:'100',state:'APPLIED',revision:2},{room_id:'r1',room_number:'101',state:cancelled?'CANCELLED':'READY_FOR_RECONCILIATION',revision:cancelled?2:1},{room_id:'r100',room_number:'200',state:'SKIPPED',revision:0,code:'ROLLOUT_UNCHANGED'}];return{batch_id:id,target:{version_number:2},items,revision:(cancelled?'b':'a').repeat(64),state:cancelled&&!retry?'PARTIALLY_COMPLETED':'IN_PROGRESS',counts:{selected:items.length,accepted:retry?1:2,APPLIED:retry?0:1,SKIPPED:retry?0:1,CANCELLED:cancelled&&!retry?1:0},reason:'Бүлгээр шинэчлэх',recorded_at:'2026-09-10T00:00:00Z',retry_of_batch_id:retry?'b1':null};};
  page.on('pageerror',e=>problems.push(e.message));
  await page.route('**/auth/**',r=>r.fulfill({json:new URL(r.request().url()).pathname==='/auth/login'?{access_token:'fake-token'}:{roles:['MANAGER']}}));
  await page.route('**/hotels/**',async r=>{
   const url=new URL(r.request().url()),tail=url.pathname.replace('/hotels/test-hotel/',''),body=r.request().postDataJSON(),method=r.request().method();let result={};
   if(tail.includes('rollout-batches'))requests.push({tail,body,method});
   if(tail==='operations')result={roles:['MANAGER'],package_mnt:30000,mode:'LIVE',staff:[]};
   else if(tail==='rooms')result=url.searchParams.get('after')?rooms.slice(100):rooms.slice(0,100);
   else if(tail==='room-categories'||tail==='stays/active')result=[];
   else if(tail==='minibar/templates')result={items:[parent],next_after:null};
   else if(tail==='minibar/templates/standard/versions')result={...parent,items:[version],next_after:null};
   else if(tail==='minibar/templates/standard/versions/v2')result={...parent,version};
   else if(tail.endsWith('/rollout-batches/preview'))result={target:{version_number:2},items:body.room_ids.map(id=>({room_id:id,room_number:rooms.find(x=>x.room_id===id).number,room_revision:4,eligible:id!=='r100',code:id==='r100'?'ROLLOUT_UNCHANGED':null,disposition:id==='r1'?'SCHEDULE_AFTER_STAY':'READY_NOW'}))};
   else if(tail.endsWith('/rollout-batches')){
    if(method==='GET'){if(historyFail){historyFail=false;return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}result={items:[batch()],next_after:null};}
    else{if(receipts.has(body.idempotency_key))return r.fulfill({status:201,json:receipts.get(body.idempotency_key)});assert(body.rooms.every(i=>i.expected_room_revision===4));result=batch(body.retry_of_batch_id?'b2':'b1');receipts.set(body.idempotency_key,result);if(lost){lost=false;return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}}
   }else if(tail.endsWith('/cancel-remaining')){if(conflict){conflict=false;return r.fulfill({status:409,json:{code:'REVISION_CONFLICT'}});}assert.equal(body.expected_revision,'a'.repeat(64));cancelled=true;result=batch();}
   else if(tail.match(/^minibar\/rollout-batches\/b[12]$/))result=batch(tail.split('/').at(-1));
   else throw Error(tail);
   await r.fulfill({status:body&&!tail.endsWith('/preview')&&!tail.endsWith('/cancel-remaining')?201:200,json:result});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false'&&!document.querySelector('form[aria-busy="true"]'));
  await page.goto(origin+'/reception#templates');await page.getByLabel('Буудлын код').fill('test-hotel');await page.getByLabel('Имэйл',{exact:true}).fill('manager@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await ready();
  await page.getByRole('button',{name:'Хувилбаруудыг нээх'}).click();await ready();await page.getByRole('button',{name:'Бүрдлийг нээх'}).click();await ready();await page.getByRole('button',{name:'Олон өрөөнд шилжүүлэх',exact:true}).click();
  const check=number=>page.getByRole('checkbox',{name:`${number} өрөө сонгох`,exact:true});
  await check('100').focus();await page.keyboard.press('Space');assert(await check('100').isChecked());assert(await page.getByRole('button',{name:'Сонгосон өрөөнүүдийг шалгах'}).isDisabled());await check('101').check();
  await page.getByRole('button',{name:'Сонголтын дараагийн хэсэг'}).click();await check('200').check();await page.getByText('Сонгосон: 3 / 100',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Сонголтын эхний хэсэг'}).click();await check('100').waitFor();assert(await check('100').isChecked());assert(await check('101').isChecked());
  await page.getByRole('button',{name:'Сонгосон өрөөнүүдийг шалгах'}).click();await page.getByLabel('Шалтгаан',{exact:true}).waitFor();await page.getByText('Өмнөх ажлууд дуусахыг хүлээнэ',{exact:true}).waitFor();
  const submit=()=>page.getByRole('button',{name:'Багцыг батлах',exact:true}).click();
  await submit();assert.equal(await page.evaluate(()=>document.activeElement.name),'reason');await page.getByLabel('Шалтгаан',{exact:true}).fill('Бүлгээр шинэчлэх');await page.getByLabel('Хувилбар, өрөө бүрийн үр дүн болон хоригийг ойлгосон').check();
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/minibar-batch-desktop.png',fullPage:true});await page.setViewportSize({width:320,height:760});await page.emulateMedia({reducedMotion:'reduce'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'artifacts/minibar-batch-mobile.png',fullPage:true});
  await submit();await page.locator('.result.error').waitFor();await submit();await page.getByRole('heading',{name:'Багцын үлдсэн ажлыг цуцлах',exact:true}).waitFor();await ready();
  const cancelFill=async()=>{await page.getByLabel('Шалтгаан',{exact:true}).fill('Үлдсэнийг цуцлах');await page.getByLabel('Үлдсэн өрөөнүүдийн ажлыг цуцлахыг баталж байна').check();};await cancelFill();await page.getByRole('button',{name:'Үлдсэн ажлыг цуцлах',exact:true}).click();await page.locator('.result.error').waitFor();assert.match(await page.locator('.result.error').textContent(),/Мэдээлэл өөрчлөгджээ/);
  await page.getByRole('button',{name:'Багцын явц шинэчлэх',exact:true}).click();await page.locator('#discard').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>document.activeElement.id),'keep');await page.locator('#leave').click();await page.getByLabel('Шалтгаан',{exact:true}).waitFor();await cancelFill();await page.getByRole('button',{name:'Үлдсэн ажлыг цуцлах',exact:true}).click();await page.getByText('Хэсэгчлэн дууссан',{exact:true}).waitFor();await ready();
  assert.equal(await page.getByRole('button',{name:'Үлдсэн ажлыг цуцлах',exact:true}).count(),0);await page.getByRole('button',{name:'Алгассан, цуцалсан өрөөг дахин сонгох'}).click();await check('101').waitFor();assert.equal(await check('100').count(),0);await check('101').check();await page.getByRole('button',{name:'Сонгосон өрөөнүүдийг шалгах'}).click();await page.getByLabel('Шалтгаан',{exact:true}).fill('Дахин оролдох');await page.getByLabel('Хувилбар, өрөө бүрийн үр дүн болон хоригийг ойлгосон').check();await submit();await page.getByText('Өмнөх багцаас дахин оролдсон. Өмнөх түүх хадгалагдсан.',{exact:true}).waitFor();await ready();
  await page.getByRole('button',{name:'Багцын түүх рүү буцах'}).click();await page.getByRole('button',{name:'Багцын түүхийг дахин ачаалах'}).click();await page.getByRole('button',{name:'Багцын явцыг нээх'}).click();await page.getByText('Хэсэгчлэн дууссан',{exact:true}).waitFor();
  const confirms=requests.filter(r=>r.body&&r.tail.endsWith('/rollout-batches'));assert.equal(confirms.length,3);assert.equal(confirms[0].body.idempotency_key,confirms[1].body.idempotency_key);assert.equal(confirms[2].body.retry_of_batch_id,'b1');assert.deepEqual(confirms[2].body.rooms.map(i=>i.room_id),['r1']);assert.equal(receipts.size,2);
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.equal(new URL(page.url()).hash,'#templates');assert.deepEqual(problems,[]);
  fs.writeFileSync('artifacts/minibar-batch-requests.json',JSON.stringify(requests));console.log('Minibar batches browser: keyboard selection across pages, preview, validation, lost response, cancel CAS, applied preservation, one-room linked retry, history retry and mobile passed.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
