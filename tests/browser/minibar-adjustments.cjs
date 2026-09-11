const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');
 await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})}).catch(e=>{server.close();throw e;});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),origin=`http://127.0.0.1:${server.address().port}`;
  const requests=[],problems=[],receipts=new Map(),history=[];let failRooms=true,failHistory=true,conflict=true,lost=true,revision=1,total=10,inRoom=2,locked=false;
  const cost={numerator:'1000',denominator:'1'};
  page.on('pageerror',e=>problems.push(e.message));
  await page.route('**/auth/**',r=>r.fulfill({json:new URL(r.request().url()).pathname==='/auth/login'?{access_token:'fake-token'}:{roles:['MANAGER']}}));
  await page.route('**/hotels/**',async r=>{
   const url=new URL(r.request().url()),tail=url.pathname.replace('/hotels/test-hotel/',''),body=r.request().postDataJSON(),method=r.request().method();let result={};
   if(body)requests.push({tail,body,method});
   if(tail==='operations')result={roles:['MANAGER'],package_mnt:30000,mode:'LIVE'};
   else if(tail==='minibar/products')result={items:[{product_id:'water',name:'Ус',status:'ACTIVE',category:'Ундаа',unit:'ш',selling_price_mnt:3000,warehouse_quantity:total-inRoom,total_quantity:total,stock_revision:revision,average_cost:cost}],next_after:null};
   else if(tail==='rooms'){if(failRooms){failRooms=false;return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}result=[{room_id:'room1',number:'101'}];}
   else if(tail.endsWith('/adjustment-preview')){const room=url.searchParams.get('room_id');result={product_id:'water',room_id:room,room_number:room?'101':null,stay_id:room?'stay1':null,stock_revision:revision,total_quantity:total,physical_quantity:room?inRoom:total-inRoom,average_cost:total?cost:null,report_locked:locked};}
   else if(tail.endsWith('/adjustments')&&!body){if(failHistory){failHistory=false;return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}result={items:history,next_after:null};}
   else if(tail.endsWith('/adjustment-corrections')){
    if(receipts.has(body.idempotency_key))return r.fulfill({json:receipts.get(body.idempotency_key)});
    const old=history.find(x=>x.adjustment_id===body.original_id);assert(old&&!old.reversed);assert.equal(body.expected_revision,revision);assert.equal(body.expected_physical_quantity,total-inRoom);assert.equal(body.kind,'COUNT_MINUS');assert.equal(body.quantity,2);assert(body.reason);
    old.reversed=true;total-=old.hotel;inRoom-=old.room;total-=body.quantity;revision+=2;
    result={correction_id:'correction1',original_id:old.adjustment_id,reversal:{adjustment_id:'reverse1'},replacement:{adjustment_id:'replacement1',total_quantity:total,stock_revision:revision}};
    receipts.set(body.idempotency_key,structuredClone(result));
    return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});
   }
   else if(tail.endsWith('/adjustments')){
    if(receipts.has(body.idempotency_key))return r.fulfill({json:receipts.get(body.idempotency_key)});
    if(conflict){conflict=false;revision++;return r.fulfill({status:409,json:{code:'REVISION_CONFLICT'}});}
    assert.equal(body.expected_revision,revision);assert.equal(body.expected_physical_quantity,body.room_id?inRoom:total-inRoom);assert.equal(body.expected_stay_id,body.room_id?'stay1':null);assert(body.reason);assert(!('reviewed' in body));
    const item={adjustment_id:'a'+history.length,kind:body.kind,quantity:body.quantity,room_id:body.room_id,room_number:body.room_id?'101':null,stay_id:body.expected_stay_id,reason:body.reason,actor_label:'Manager',recorded_at:'2026-09-10T09:00:00Z',cost,reversed:false};
    let hotel=body.kind==='RETURN'?0:body.kind==='COUNT_PLUS'?body.quantity:-body.quantity,room=body.room_id?-body.quantity:0;
    if(body.kind==='COUNT_PLUS'&&body.room_id)room=body.quantity;
    if(body.kind==='REVERSAL'){const old=history.find(x=>x.adjustment_id===body.original_id);assert(old&&!old.reversed);old.reversed=true;hotel=-old.hotel;room=-old.room;}
    item.hotel=hotel;item.room=room;history.push(item);total+=hotel;inRoom+=room;revision++;
    result={adjustment_id:item.adjustment_id,kind:body.kind,stock_revision:revision};receipts.set(body.idempotency_key,structuredClone(result));
    if(lost){lost=false;return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}
   }else throw Error(tail);
   await r.fulfill({json:result});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false'&&!document.querySelector('form[aria-busy="true"]'));
  await page.goto(origin+'/reception#inventory');await page.getByLabel('Буудлын код').fill('test-hotel');await page.getByLabel('Имэйл',{exact:true}).fill('manager@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await ready();
  const open=async(kind='WASTE',room='')=>{await page.getByRole('button',{name:'Нөөцийн хөдөлгөөн бүртгэх',exact:true}).click();await Promise.race([page.getByLabel('Байршил').waitFor(),page.getByRole('button',{name:'Хөдөлгөөнийг дахин ачаалах'}).waitFor()]);if(await page.getByRole('button',{name:'Хөдөлгөөнийг дахин ачаалах'}).count())await page.getByRole('button',{name:'Хөдөлгөөнийг дахин ачаалах'}).click();await page.getByLabel('Байршил').selectOption(room);await page.getByLabel('Хөдөлгөөний төрөл').selectOption(kind);await page.getByRole('button',{name:'Үлдэгдлийг шалгах'}).click();await page.getByRole('button',{name:'Хөдөлгөөн баталгаажуулах'}).waitFor();};
  const fill=async(quantity='1')=>{await page.getByLabel('Хөдөлгөөний тоо',{exact:true}).fill(quantity);await page.getByLabel('Шалтгаан',{exact:true}).fill('Бодит тооллогын шалтгаан');await page.getByLabel('Тоо, байршил болон үр дүнг шалгасан').check();};
  const submit=()=>page.getByRole('button',{name:'Хөдөлгөөн баталгаажуулах'}).click();
  await open();await submit();assert.equal(await page.evaluate(()=>document.activeElement.name),'quantity');await fill();await submit();await page.locator('.result.error').waitFor();
  await page.locator('#refresh').click();await page.locator('#discard').waitFor({state:'visible'});await page.locator('#leave').click();await ready();await open();await fill();
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/minibar-adjustments-desktop.png',fullPage:true});await page.setViewportSize({width:320,height:760});await page.emulateMedia({reducedMotion:'reduce'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'artifacts/minibar-adjustments-mobile.png',fullPage:true});
  await submit();await page.locator('.result.error').waitFor();await submit();await ready();assert.equal(total,9);
  await open('RETURN','room1');await fill();await submit();await ready();assert.equal(inRoom,1);assert.equal(total,9);
  await page.getByRole('button',{name:'Залруулгын түүх',exact:true}).click();await page.getByRole('button',{name:'Залруулгын түүхийг дахин ачаалах'}).click();await page.getByRole('button',{name:'Энэ хөдөлгөөнийг буцаах'}).last().click();await page.getByLabel('Шалтгаан',{exact:true}).fill('Буцаалтыг залруулах');await page.getByLabel('Тоо, байршил болон үр дүнг шалгасан').check();await submit();await ready();assert.equal(inRoom,2);
  await open('COUNT_PLUS');await fill('2');await submit();await ready();await open('COUNT_MINUS');await fill();await submit();await ready();assert.equal(total,10);
  await page.getByRole('button',{name:'Залруулгын түүх',exact:true}).click();await page.getByRole('button',{name:'Зөв хөдөлгөөнөөр солих'}).first().click();
  await page.getByLabel('Зөв хөдөлгөөний төрөл').selectOption('COUNT_MINUS');await page.getByRole('button',{name:'Залруулгыг шалгах'}).click();await fill('2');
  assert(await page.getByText('Анхны хөдөлгөөнийг буцааж, доорх зөв хөдөлгөөнөөр хамтад нь солино.',{exact:false}).count());
  await page.screenshot({path:'artifacts/minibar-atomic-correction-mobile.png',fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await submit();await page.locator('.result.error').waitFor();await submit();await ready();assert.equal(total,9);
  const corrections=requests.filter(r=>r.tail.endsWith('/adjustment-corrections'));assert.equal(corrections.length,2);assert.deepEqual(corrections[0].body,corrections[1].body);
  total=0;inRoom=0;await open('COUNT_PLUS');await fill('2');await page.getByLabel('Өртөггүй нөөцийн нэгж өртөг').fill('1500');await submit();await ready();assert.equal(total,2);
  locked=true;await page.getByRole('button',{name:'Нөөцийн хөдөлгөөн бүртгэх',exact:true}).click();await page.getByLabel('Байршил').selectOption('room1');await page.getByRole('button',{name:'Үлдэгдлийг шалгах'}).click();await page.getByText('Энэ байрлалтын тайлан бүртгэгдсэн эсвэл зочин солигдсон тул хөдөлгөөнийг эндээс өөрчлөхгүй.').waitFor();assert.equal(await page.getByRole('button',{name:'Хөдөлгөөн баталгаажуулах'}).count(),0);
  assert.equal(requests[1].body.idempotency_key,requests[2].body.idempotency_key);assert.notEqual(requests[0].body.idempotency_key,requests[1].body.idempotency_key);
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.deepEqual(problems,[]);
  fs.writeFileSync('artifacts/minibar-adjustment-requests.json',JSON.stringify(requests));console.log('Minibar adjustments browser: preview, reason/ack, CAS, unknown outcome, warehouse/room stock, reversal, zero-stock cost, report lock, keyboard and 320px passed.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
