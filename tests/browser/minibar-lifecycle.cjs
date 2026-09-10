const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');
 await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})}).catch(e=>{server.close();throw e;});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),origin=`http://127.0.0.1:${server.address().port}`;
  const requests=[],problems=[],receipts=new Map();let fail=true,lost=true,conflict=true;
  const product={entity_id:'water',kind:'product',name:'Ус',status:'ACTIVE',revision:1};
  const template={entity_id:'standard',kind:'template',name:'Стандарт',status:'ACTIVE',revision:4};
  const blockers=entity=>entity===product&&template.status==='ACTIVE'?[{kind:'ACTIVE_TEMPLATE',count:1}]:[];
  page.on('pageerror',e=>problems.push(e.message));
  await page.route('**/auth/**',r=>r.fulfill({json:new URL(r.request().url()).pathname==='/auth/login'?{access_token:'fake-token'}:{roles:['MANAGER']}}));
  await page.route('**/hotels/**',async r=>{
   const tail=new URL(r.request().url()).pathname.replace('/hotels/test-hotel/',''),body=r.request().postDataJSON(),method=r.request().method();let result={};
   if(tail.startsWith('minibar/'))requests.push({tail,body,method});
   if(tail==='operations')result={roles:['MANAGER'],package_mnt:30000,mode:'LIVE'};
   else if(tail==='minibar/products')result={items:[{...product,product_id:'water',category:'Ундаа',unit:'ш',selling_price_mnt:3000,warehouse_quantity:10,stock_revision:1,average_cost:{numerator:'1000',denominator:'1'}}],next_after:null};
   else if(tail==='minibar/templates')result={items:[{...template,template_id:'standard',default_version_id:'v1'}],next_after:null};
   else if(tail==='minibar/templates/standard/versions')result={...template,template_id:'standard',items:[],next_after:null};
   else if(tail.endsWith('/lifecycle')){
    const entity=tail.includes('/products/')?product:template;
    if(!body){if(fail){fail=false;return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}result={...entity,blockers:blockers(entity)};}
    else{
     if(receipts.has(body.idempotency_key))return r.fulfill({json:receipts.get(body.idempotency_key)});
     if(conflict){conflict=false;entity.revision++;return r.fulfill({status:409,json:{code:'REVISION_CONFLICT'}});}
     assert.equal(body.expected_revision,entity.revision);assert(body.reason);
     entity.status=body.action==='DEACTIVATE'?(blockers(entity).length?'RETIRING':'INACTIVE'):'ACTIVE';entity.revision++;
     result={...entity,blockers:blockers(entity)};receipts.set(body.idempotency_key,structuredClone(result));
     if(template.status==='INACTIVE'&&product.status==='RETIRING'){product.status='INACTIVE';product.revision++;}
     if(lost){lost=false;return r.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});}
    }
   }else throw Error(tail);
   await r.fulfill({json:result});
  });
  const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false'&&!document.querySelector('form[aria-busy="true"]'));
  await page.goto(origin+'/reception#inventory');await page.getByLabel('Буудлын код').fill('test-hotel');await page.getByLabel('Имэйл',{exact:true}).fill('manager@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await ready();
  const open=async()=>{await page.getByRole('button',{name:'Идэвхтэй төлөв удирдах',exact:true}).click();};
  const fill=async()=>{await page.getByLabel('Шалтгаан',{exact:true}).fill('Бүрдлээс гаргах');await page.getByLabel('Төлөв өөрчлөх үр дүнг ойлгосон').check();};
  await open();await page.getByRole('button',{name:'Төлөвийг дахин ачаалах'}).click();await page.getByLabel('Шалтгаан',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Идэвхгүй болгох',exact:true}).click();assert.equal(await page.evaluate(()=>document.activeElement.name),'reason');await fill();
  await page.getByRole('button',{name:'Идэвхгүй болгох',exact:true}).click();await page.locator('.result.error').waitFor();
  await page.locator('#refresh').click();await page.locator('#discard').waitFor({state:'visible'});await page.locator('#leave').click();await ready();await open();await fill();
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/minibar-lifecycle-desktop.png',fullPage:true});await page.setViewportSize({width:320,height:760});await page.emulateMedia({reducedMotion:'reduce'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'artifacts/minibar-lifecycle-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'Идэвхгүй болгох',exact:true}).click();await page.locator('.result.error').waitFor();await page.getByRole('button',{name:'Идэвхгүй болгох',exact:true}).click();await ready();
  assert.equal(product.status,'RETIRING');assert.equal(await page.getByRole('button',{name:'Орлого бүртгэх',exact:true}).count(),0);
  await open();await fill();await page.getByRole('button',{name:'Идэвхгүй болгох хүсэлтийг цуцлах',exact:true}).click();await ready();assert.equal(product.status,'ACTIVE');
  await open();await fill();await page.getByRole('button',{name:'Идэвхгүй болгох',exact:true}).click();await ready();
  await page.getByRole('link',{name:'Минибарын загвар',exact:true}).click();await ready();await page.getByRole('button',{name:'Хувилбаруудыг нээх'}).click();await ready();await open();await fill();await page.getByRole('button',{name:'Идэвхгүй болгох',exact:true}).click();await ready();assert.equal(template.status,'INACTIVE');assert.equal(product.status,'INACTIVE');
  await page.getByRole('link',{name:'Агуулах',exact:true}).click();await ready();await open();await fill();await page.getByRole('button',{name:'Дахин идэвхжүүлэх',exact:true}).click();await ready();assert.equal(product.status,'ACTIVE');
  const commands=requests.filter(r=>r.body&&r.tail.endsWith('/lifecycle'));assert.equal(commands[1].body.idempotency_key,commands[2].body.idempotency_key);assert.notEqual(commands[0].body.idempotency_key,commands[1].body.idempotency_key);
  assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);assert.deepEqual(problems,[]);
  fs.writeFileSync('artifacts/minibar-lifecycle-requests.json',JSON.stringify(requests));console.log('Minibar lifecycle browser: preview, failure/retry, reason/ack, CAS, unknown outcome, retirement/cancel/reactivation and 320px passed.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
