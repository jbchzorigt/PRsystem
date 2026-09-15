const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):req.url.startsWith('/guest/entry')?'guest.html':'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');
 await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:1000}}),origin=`http://127.0.0.1:${server.address().port}`,requests=[],errors=[],receipts=new Map();
  let menu={item_id:'soup',category:'Хоол',name:'Шөл',description:'Халуун шөл',price_mnt:4000,active:true,available:true,revision:1},order=null,failAccept=true,expired=false;
  const summary=()=>structuredClone(order);
  const state=()=>({order:'CONFIRMED',fulfillment:'AWAITING_ACCEPTANCE',payment:'PAID',refund_policy:'NONE',refund_request:'NONE',refund:'NONE',handoff:'ROOM'});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/auth/**',route=>route.fulfill({json:new URL(route.request().url()).pathname==='/auth/me'?{roles:['RECEPTION','MANAGER_PLUS']}:{access_token:'restaurant-token'}}));
  let profile={name:'Талын ресторан',category:'Хоол',description:'Өдөр тутмын хоол',address:'Улаанбаатар',latitude:47.9,longitude:106.9,phone:'99112233',weekly_hours:Array.from({length:7},(_,day)=>({day,closed:false,opens:'09:00',closes:'18:00'})),closed_dates:[],revision:0},linkActive=true,linkRevision=0;
  await page.route('**/hotels/**',async route=>{
   const url=new URL(route.request().url()),body=route.request().postDataJSON(),tail=url.pathname.replace('/hotels/hotel/','');if(!url.pathname.startsWith('/hotels/hotel/'))return route.fallback();if(body)requests.push({path:url.pathname,method:route.request().method(),body});
   if(tail==='operations')return route.fulfill({json:{roles:['RECEPTION','MANAGER_PLUS'],package_mnt:30000,mode:'LIVE',staff:[],funding:[],cleaning:[],inspections:[],limit:100}});
   if(['rooms','stays/active','room-categories','bookings','cleaning/checkouts'].includes(tail))return route.fulfill({json:[]});
   if(tail==='restaurant-settings')return route.fulfill({json:[{restaurant_id:'venue',name:profile.name,active:linkActive,link_revision:linkRevision,revision:profile.revision}]});
   if(tail==='restaurants/venue/settings'){
    if(body){assert.equal(body.expected_revision,profile.revision);assert.deepEqual(body.closed_dates,['2026-09-15']);assert.equal(body.weekly_hours[0].closed,true);assert(body.reason);profile={...body,revision:profile.revision+1};}
    return route.fulfill({json:profile});
   }
   if(tail==='restaurants/venue/link-state'){assert.equal(body.expected_revision,linkRevision);assert.equal(body.active,false);linkActive=false;linkRevision++;return route.fulfill({json:{active:false,revision:linkRevision}});}
   throw new Error('Unexpected hotel request '+tail);
  });
  await page.route('**/restaurants/**',async route=>{
   const url=new URL(route.request().url()),body=route.request().postDataJSON();
   if(url.pathname.startsWith('/auth/')||url.pathname.startsWith('/hotels/'))return route.fallback();
   if(expired)return route.fulfill({status:401,json:{code:'UNAUTHENTICATED'}});
   if(body)requests.push({path:url.pathname,method:route.request().method(),body});
   if(body&&receipts.has(body.idempotency_key))return route.fulfill({json:receipts.get(body.idempotency_key)});
   if(url.pathname.endsWith('/menu')&&!body)return route.fulfill({json:{items:[menu],next_after:null}});
   if(url.pathname.endsWith('/menu/soup/image')){assert.equal(body.expected_revision,menu.revision);menu.image_data=body.image;menu.revision++;return route.fulfill({json:{revision:menu.revision}});}
   if(url.pathname.endsWith('/notifications'))return route.fulfill({json:{items:[{order_id:'order-1',code:'ORDER_PAID',room_number:'101',restaurant_name:'Талын ресторан',recorded_at:'2026-09-14T04:00:00Z'}],next_after:null}});
   if(url.pathname.endsWith('/menu/soup')&&body){assert.equal(body.expected_revision,menu.revision);assert.equal(body.price_mnt,5000);menu={...menu,...body,revision:2};return route.fulfill({json:{revision:2}});}
   if(url.pathname.endsWith('/orders')&&!body)return route.fulfill({json:{orders:order?[summary()]:[],next_after:null}});
   assert.equal(body.expected_revision,order.revision);
   if(url.pathname.endsWith('/accept')){assert.equal(body.eta_minutes,30);order.state.fulfillment='ACCEPTED';order.state.promised_ready_at='2026-09-14T04:30:00Z';order.revision++;const result={revision:order.revision,state:order.state};receipts.set(body.idempotency_key,result);if(failAccept){failAccept=false;return route.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}return route.fulfill({json:result});}
   if(url.pathname.endsWith('/fulfill')){assert.equal(body.fulfillment,'PREPARING');order.state.fulfillment='PREPARING';order.revision++;return route.fulfill({json:{revision:order.revision,state:order.state}});}
   throw new Error('Unexpected restaurant request '+url.pathname);
  });
  await page.route('**/guest/**',async route=>{
   const url=new URL(route.request().url()),body=route.request().postDataJSON();
   if(url.pathname==='/guest/entry')return route.continue();
   if(body)requests.push({path:url.pathname,method:route.request().method(),body});
   if(url.pathname==='/guest/access'){assert.equal(body.qr_token,'q'.repeat(43));return route.fulfill({json:{access_token:'guest-token'}});}
   if(url.pathname==='/guest/session')return route.fulfill({json:{room_number:'101',planned_checkout_at:'2026-09-15T04:00:00Z'}});
   if(url.pathname==='/guest/restaurants')return route.fulfill({json:[{restaurant_id:'venue',name:'Талын ресторан',active:true}]});
   if(url.pathname.endsWith('/menu'))return route.fulfill({json:{restaurant_id:'venue',name:'Талын ресторан',ordering_available:true,items:[menu]}});
   if(url.pathname==='/guest/restaurants/venue/orders'){
    assert.deepEqual(body.quantities,{soup:2});assert.deepEqual(Object.keys(body).sort(),['idempotency_key','quantities']);
    order={order_id:'order-1',tenant_id:'hotel',restaurant_id:'venue',restaurant_name_snapshot:'Талын ресторан',room_number_snapshot:'101',contact_phone:'99112233',created_at:'2026-09-14T04:00:00Z',expires_at:'2026-09-14T04:15:00Z',amount_mnt:8000,items:[{name:'Шөл',quantity:2,unit_price_mnt:4000,amount_mnt:8000}],invoice_id:null,state:null,revision:0,alerts:{}};
    return route.fulfill({json:{order_id:order.order_id,amount_mnt:8000}});
   }
   if(url.pathname==='/guest/restaurant-orders/order-1/invoice'){order.invoice_id='mock-invoice';order.state={...state(),order:'PENDING_PAYMENT',fulfillment:'NOT_STARTED',payment:'PENDING'};order.revision++;return route.fulfill({json:summary()});}
   if(url.pathname.endsWith('/reconcile-payment')){assert.equal(body.expected_revision,order.revision);order.state=state();order.revision++;order.alerts={acceptance_reception:true,acceptance_warning:true};return route.fulfill({json:summary()});}
   if(url.pathname==='/guest/restaurant-orders/order-1')return route.fulfill({json:summary()});
   if(url.pathname==='/guest/restaurant-orders')return route.fulfill({json:{orders:order?[summary()]:[],next_after:null}});
   throw new Error('Unexpected guest request '+url.pathname);
  });
  await page.goto(origin+'/guest/entry#qr='+'q'.repeat(43));assert.equal(new URL(page.url()).hash,'');await page.getByLabel('Reception-оос авсан 6 оронтой код').fill('123456');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.getByRole('button',{name:'Талын ресторан меню'}).click();
  await page.getByRole('button',{name:'Сагсыг батлах'}).click();await page.locator('.result.error').waitFor();assert.equal(requests.filter(r=>r.path.endsWith('/venue/orders')).length,0);
  await page.getByLabel(/Шөл.*— тоо/).fill('2');await page.getByRole('button',{name:'Сагсыг батлах'}).click();await page.getByRole('link',{name:/Ресторан руу залгах/}).waitFor();assert.equal(await page.getByRole('link',{name:/Ресторан руу залгах/}).getAttribute('href'),'tel:99112233');
  await page.getByLabel(/дүн, бүтээгдэхүүний тоог шалгасан/).check();await page.getByRole('button',{name:'Төлбөрийн нэхэмжлэл үүсгэх'}).click();await page.getByRole('button',{name:'Төлбөрийн төлөв шалгах'}).click();await page.getByRole('button',{name:'Цуцлалт, бүтэн буцаалт хүсэх'}).waitFor();
  await page.setViewportSize({width:320,height:720});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/restaurant-guest-mobile.png',fullPage:true});
  await page.goto(origin+'/restaurant');await page.getByLabel('Рестораны код').fill('venue');await page.getByLabel('Имэйл',{exact:true}).fill('chef@example.test');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.getByLabel('Бэлэн болох хугацаа').selectOption('30');
  await page.getByRole('button',{name:'Захиалга хүлээн авах',exact:true}).click();await page.locator('.result.error').waitFor();const first=requests.filter(r=>r.path.endsWith('/accept'))[0];await page.getByRole('button',{name:'Захиалга хүлээн авах',exact:true}).click();await page.getByRole('button',{name:'Хүргэлтийн явцыг батлах',exact:true}).waitFor();assert.equal(requests.filter(r=>r.path.endsWith('/accept'))[1].body.idempotency_key,first.body.idempotency_key);
  await page.getByRole('button',{name:'Хүргэлтийн явцыг батлах',exact:true}).click();await page.getByLabel('Бодитоор гүйцэтгэсэн ажил').selectOption('READY');
  await page.getByRole('button',{name:'Меню удирдах',exact:true}).click();await page.locator('#discard').waitFor();await page.getByRole('button',{name:'Маягтыг орхих',exact:true}).click();await page.getByRole('button',{name:'Шөл засах',exact:true}).click();await page.getByLabel('Нэгж үнэ (₮)',{exact:true}).fill('5000');await page.getByRole('button',{name:'Меню хадгалах',exact:true}).click();await page.getByRole('button',{name:'Шөл засах',exact:true}).waitFor();
  await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'artifacts/restaurant-menu-desktop.png',fullPage:true});assert.equal(await page.locator('form:not([novalidate])').count(),0);assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  await page.getByRole('button',{name:'Шөл зураг',exact:true}).click();await page.getByLabel(/Нийтлэх зураг/).setInputFiles({name:'soup.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY9sAAAAASUVORK5CYII=','base64')});await page.getByRole('button',{name:'Зураг хадгалах',exact:true}).click();await page.getByRole('button',{name:'Зураг арилгах',exact:true}).waitFor();await page.getByRole('button',{name:'Зураг арилгах',exact:true}).click();await page.getByRole('button',{name:'Шөл зураг',exact:true}).waitFor();assert.equal(menu.image_data,null);
  await page.getByRole('button',{name:'Рестораны мэдэгдлүүд',exact:true}).click();await page.getByRole('heading',{name:'Мэдэгдлийн түүх',exact:true}).waitFor();assert.match(await page.locator('#content').textContent(),/Төлбөр баталгаажсан/);
  expired=true;await page.getByRole('button',{name:'Мэдээлэл шинэчлэх',exact:true}).click();await page.getByRole('heading',{name:'Рестораны ажилтнаар нэвтрэх'}).waitFor();assert.equal(await page.locator('#content').textContent(),'');assert.deepEqual(errors,[]);
  expired=false;await page.goto(origin+'/reception');await page.getByLabel('Буудлын код').fill('hotel');await page.getByLabel('Имэйл',{exact:true}).fill('manager@example.test');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.getByRole('link',{name:'Ресторан',exact:true}).click();await page.getByRole('button',{name:'Ресторан, цагийн хуваарь удирдах',exact:true}).click();await page.getByRole('button',{name:'Талын ресторан мэдээлэл, цагийн хуваарь',exact:true}).click();await page.getByLabel('Даваа — амарна',{exact:false}).check();await page.getByLabel(/Нэмэлт амралтын огноо/).fill('2026-09-15');await page.getByLabel('Шалтгаан',{exact:true}).fill('Засварын өдрүүд');await page.getByRole('button',{name:'Рестораны тохиргоо хадгалах',exact:true}).click();await page.getByRole('button',{name:'Холбоосыг идэвхгүй болгох',exact:true}).click();await page.getByRole('button',{name:'Холбоосыг идэвхжүүлэх',exact:true}).waitFor();assert.equal(linkActive,false);
  await page.setViewportSize({width:320,height:720});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'artifacts/restaurant-manager-mobile.png',fullPage:true});assert.deepEqual(errors,[]);
  fs.writeFileSync('artifacts/restaurant-requests.json',JSON.stringify(requests));console.log(`Restaurant browser checks passed: ${requests.length} API commands, guest cart/invoice, staff acceptance retry, fulfillment, menu editing, dirty guard, expiry and responsive layout.`);
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
