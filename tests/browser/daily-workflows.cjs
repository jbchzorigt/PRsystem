const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),origin=`http://127.0.0.1:${server.address().port}`,requests=[],problems=[];
  page.on('pageerror',e=>problems.push(e.message));
  let releaseRead=null,holdRead=false,role='MANAGER',readFailure=false,failAfterCreate=false,rankFailure=true,claimed=false,started=false,remaining=1;
  const categories=[{category_id:'standard',name:'Стандарт',status:'ACTIVE',revision:2}],room={room_id:'room-1',number:'201',floor:'2',category_id:'standard',category_name:'Стандарт',status:'ACTIVE',cleaning_state:'DIRTY',revision:2,minibar_mode:'OFF',tariffs:{}};
  const oldPhoto='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=';
  let profile={name:'Туршилтын буудал',address:'Улаанбаатар',phone:'99112233',description:'Туршилтын тайлбар',latitude:47.9,longitude:106.9,photos:[oldPhoto],published:true,accepting:true,revision:7};
  const settings=()=>({profile,categories:categories.map((c,i)=>({category_id:c.category_id,rank:i+2,rank_revision:i+4,published:i===0,publication_revision:i+8}))});
  const task=()=>({task_id:'task-1',source_id:'source-1',room_id:'room-1',room_number:'201',floor:'2',category_name:'Стандарт',assignment_version:3,started_at:started?'2026-09-15T00:00:00Z':null,action_id:'clean-1',kind:'CLEAN',remaining});
  const overview=()=>({account_id:'worker',roles:[role],package_mnt:25000,mode:'MOCK_CASH_LEDGER',limit:50,settings:[10000,80000,'12:00',4],deposit_settings:[60000,2],staff:[],drawers:[],shifts:[],funding:[],custodies:[],qrs:[],inspections:[],cleaning:claimed&&remaining?[task()]:[]});
  await page.route('**/auth/**',route=>route.fulfill({json:new URL(route.request().url()).pathname==='/auth/login'?{access_token:'test-session'}:{roles:[role]}}));
  await page.route('**/hotels/**',async route=>{
   const req=route.request(),tail=new URL(req.url()).pathname.replace('/hotels/test-hotel/',''),body=req.postDataJSON(),method=req.method();requests.push({tail,body,method});let data={};
   if(tail==='operations'){if(holdRead)await new Promise(resolve=>{releaseRead=resolve;});if(readFailure)return route.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});data=overview();}
   else if(tail==='rooms'&&!body)data=[room];
   else if(tail==='room-categories'&&!body)data=categories;
   else if(['stays/active','bookings','booking-holds'].includes(tail))data=[];
   else if(tail==='room-categories'&&body){categories.push({category_id:'category-'+categories.length,name:body.name,status:'ACTIVE',revision:0});data=categories.at(-1);if(failAfterCreate)readFailure=true;}
   else if(tail==='rooms'&&body){assert.equal(body.number,'202');data={room_id:'new-room'};}
   else if(tail==='booking-settings')data=settings();
   else if(tail.endsWith('/booking-rank')){assert.equal(body.expected_revision,5);assert.equal(body.rank,9);if(rankFailure)return route.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});data={revision:6};}
   else if(tail==='booking-profile'){assert.equal(body.expected_revision,7);assert.deepEqual(body.photos,[oldPhoto]);profile={...body,revision:8};delete profile.idempotency_key;delete profile.expected_revision;data={revision:8};}
   else if(tail.endsWith('/publication')){assert.equal(body.expected_revision,9);assert.equal(body.published,true);assert.match(body.photos[0],/^data:image\/png;base64,/);data={revision:10};}
   else if(tail==='cleaning/checkouts')data=remaining?[{...task(),stay_id:'stay-1',task_id:claimed?'task-1':null}]:[];
   else if(tail.endsWith('/checkout-cleaning/claim')){claimed=true;data=task();}
   else if(tail.endsWith('/start')){assert.equal(body.expected_revision,3);started=true;data=task();}
   else if(tail.endsWith('/post')){assert.equal(body.quantity,1);assert.equal(body.action_id,'clean-1');assert.equal(body.expected_revision,3);remaining=0;data={state:'DONE'};}
   else throw Error('Unexpected route: '+method+' '+tail);
   await route.fulfill({json:data});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false');
  const f=name=>page.getByRole('form',{name,exact:true});
  const login=async hash=>{await page.goto(origin+'/reception?fixture='+role+'#'+hash);await page.getByLabel('Буудлын код').fill('test-hotel');await page.getByLabel('Имэйл',{exact:true}).fill('worker@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await ready();};
  const createCategory=async name=>{const form=f('Өрөөний ангилал үүсгэх');await form.getByLabel('Ангиллын нэр',{exact:true}).fill(name);await form.getByRole('button',{name:'Бүртгэх',exact:true}).click();};
  await login('manager');await createCategory('Делюкс');await f('Өрөө бүртгэх').locator('option[value="category-1"]').waitFor({state:'attached'});
  // Another form's edits survive a confirmed create; explicit refresh still asks.
  await f('Өрөө бүртгэх').getByLabel('Өрөөний дугаар').fill('202');await f('Өрөө бүртгэх').getByLabel('Давхар',{exact:true}).fill('2');await createCategory('Гэр бүлийн');
  await page.getByRole('button',{name:'Хадгалсан мэдээллийг дахин ачаалах'}).click();await page.locator('#discard').waitFor({state:'visible'});await page.locator('#keep').click();assert.equal(await f('Өрөө бүртгэх').getByLabel('Өрөөний дугаар').inputValue(),'202');
  await f('Өрөө бүртгэх').getByRole('button',{name:'Бүртгэх',exact:true}).click();await f('Өрөө бүртгэх').locator('option[value="category-2"]').waitFor({state:'attached'});
  // A successful command followed by a failed read cannot become another create.
  failAfterCreate=true;const retired=await f('Өрөөний ангилал үүсгэх').elementHandle();await createCategory('Хосын');await page.getByText('Хадгалсан. Шинэ мэдээллийг ачаалж чадсангүй.',{exact:true}).waitFor();
  assert.equal(await f('Өрөөний ангилал үүсгэх').count(),0);const writes=requests.filter(r=>r.tail==='room-categories'&&r.body).length;
  await retired.evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));assert.equal(requests.filter(r=>r.tail==='room-categories'&&r.body).length,writes);
  readFailure=false;failAfterCreate=false;await page.getByRole('button',{name:'Хадгалсан мэдээллийг дахин ачаалах'}).click();await f('Өрөөний ангилал үүсгэх').waitFor();
  // Edits made while the post-save GET is in flight also survive.
  holdRead=true;await createCategory('Уншиж байх үеийн туршилт');await page.getByRole('heading',{name:'Өрөөний ангилал үүслээ. Өрөө бүртгэхэд сонгож болно.',exact:true}).waitFor();
  await f('Өрөө бүртгэх').getByLabel('Өрөөний дугаар').fill('Санамсаргүй алдагдах ёсгүй');assert.ok(releaseRead);holdRead=false;releaseRead();
  await page.getByRole('button',{name:'Хадгалсан мэдээллийг дахин ачаалах'}).waitFor();assert.equal(await f('Өрөө бүртгэх').getByLabel('Өрөөний дугаар').inputValue(),'Санамсаргүй алдагдах ёсгүй');
  await page.getByRole('button',{name:'Хадгалсан мэдээллийг дахин ачаалах'}).click();await page.locator('#discard').waitFor({state:'visible'});await page.locator('#leave').click();await f('Өрөөний ангилал үүсгэх').waitFor();
  await page.locator('a[href="#online"]').click();await f('Ангиллын түвшин тохируулах').waitFor();assert.equal(await page.locator('input[name=expected_revision]').count(),0);
  const rank=f('Ангиллын түвшин тохируулах');await rank.getByLabel('Ангилал',{exact:true}).selectOption('category-1');assert.equal(await rank.locator('[name=rank]').inputValue(),'3');await rank.locator('[name=rank]').fill('9');await rank.getByRole('button',{name:'Түвшин хадгалах'}).click();await rank.locator('.result.error').waitFor();
  rankFailure=false;await rank.getByRole('button',{name:'Түвшин хадгалах'}).click();await page.getByText('Ангиллын түвшин хадгалагдлаа.',{exact:true}).waitFor();const retries=requests.filter(r=>r.tail.endsWith('/booking-rank'));assert.equal(retries.length,2);assert.deepEqual(retries[0].body,retries[1].body);
  const profileForm=f('Буудлын нийтийн мэдээлэл');await profileForm.locator('[name=latitude]').fill('91');await profileForm.getByRole('button',{name:'Профайл хадгалах'}).click();assert.equal(await profileForm.locator('[name=latitude]').getAttribute('aria-invalid'),'true');await profileForm.locator('[name=latitude]').fill('47.8');await profileForm.getByRole('button',{name:'Профайл хадгалах'}).click();await page.getByText('Буудлын нийтийн мэдээлэл хадгалагдлаа.',{exact:true}).waitFor();
  const publication=f('Ангиллыг нийтлэх');await publication.locator('[name=category_id]').selectOption('category-1');assert.equal(await publication.locator('[name=published]').isChecked(),false);await publication.locator('[name=published]').check();await publication.locator('[name=photo]').setInputFiles({name:'hotel.png',mimeType:'image/png',buffer:Buffer.from(oldPhoto.split(',')[1],'base64')});await publication.getByRole('button',{name:'Нийтлэх төлөв хадгалах'}).click();await page.getByText('Ангиллын нийтлэх төлөв хадгалагдлаа.',{exact:true}).waitFor();
  // Cleaner gets room identity from its permitted read projection, never room/guest detail.
  role='CLEANER';const beforeCleaner=requests.length;await login('cleaning');await page.setViewportSize({width:320,height:700});await page.getByRole('heading',{name:'201 өрөө · Зочин гарсны дараах цэвэрлэгээ'}).waitFor();assert.match(await page.locator('#content').textContent(),/2 давхар · Стандарт/);assert.equal(await page.getByText('Бусад цэвэрлэгээний нээлттэй ажил алга.',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Бүртгэх',exact:true}).click();await f('Цэвэрлэгээ эхлүүлэх').waitFor();await f('Цэвэрлэгээ эхлүүлэх').getByRole('button',{name:'Бүртгэх',exact:true}).click();await f('Өрөөний цэвэрлэгээг батлах').waitFor();
  await f('Өрөөний цэвэрлэгээг батлах').getByLabel('Гүйцэтгэсэн тоо').fill('2');await f('Өрөөний цэвэрлэгээг батлах').getByRole('button',{name:'Бүртгэх',exact:true}).click();assert.equal(requests.filter(r=>r.tail.endsWith('/post')).length,0);assert.equal(await page.locator('[name=quantity]').getAttribute('aria-invalid'),'true');
  await page.locator('[name=quantity]').fill('1');fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/daily-cleaner-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await f('Өрөөний цэвэрлэгээг батлах').getByRole('button',{name:'Бүртгэх',exact:true}).click();await page.getByText('Бусад цэвэрлэгээний нээлттэй ажил алга.',{exact:true}).waitFor();assert.equal(await f('Өрөөний цэвэрлэгээг батлах').count(),0);
  assert.equal(requests.slice(beforeCleaner).some(r=>['rooms','room-categories','stays/active'].includes(r.tail)||r.tail.endsWith('/guest')),false);assert.deepEqual(problems,[]);assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/daily-workflow-requests.json',JSON.stringify(requests));console.log('Daily workflow checks passed: saved command retirement, dirty sibling preservation, read recovery, canonical revision retry, existing photos, room-labeled Cleaner claim/start/complete and 320px reflow.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
