const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
(async()=>{
  const server=http.createServer((req,res)=>{
    const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
    res.end(fs.readFileSync(path.join(root,file)));
  }).listen(0,'127.0.0.1');
  await new Promise(r=>server.on('listening',r));
  const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})}).catch(error=>{server.close();throw error;});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}}),origin=`http://127.0.0.1:${server.address().port}`;
    let product=null,createCount=0,conflict=true,packageMnt=30000,role='MANAGER',ledgerFail=false;
    const requests=[],problems=[],history=[];page.on('pageerror',e=>problems.push(e.message));
    const snap=(kind,quantity,cost)=>({receipt_id:'r'+history.length,stock_revision:product.stock_revision,kind,quantity,unit_cost_mnt:cost,warehouse_quantity:product.warehouse_quantity,reference:'INV-001',actor_id:'manager-1',actor_label:'Бат',recorded_at:'2026-09-09T01:00:00Z'});
    await page.route('**/auth/**',route=>route.fulfill({json:new URL(route.request().url()).pathname==='/auth/login'?{access_token:'test-session'}:{roles:[role]}}));
    await page.route('**/hotels/**',async route=>{
      const url=new URL(route.request().url()),tail=url.pathname.replace('/hotels/test-hotel/',''),body=route.request().postDataJSON();
      if(tail.startsWith('minibar/'))requests.push({tail,body,method:route.request().method()});
      if(body)await new Promise(r=>setTimeout(r,150));
      let data={};
      if(tail==='operations')data={roles:[role],package_mnt:packageMnt,mode:'LIVE',hotel_settings:[10000,80000,'12:00',1],deposit_settings:[60000,1],funding:[]};
      else if(['rooms','room-categories','stays/active','bookings'].includes(tail))data=[];
      else if(tail==='minibar/products'&&!body)data={items:product?[product]:[],next_after:null};
      else if(tail==='minibar/products'){
        createCount++;
        if(!product){product={product_id:'product-1',...body,warehouse_quantity:body.opening_quantity,stock_revision:1,average_cost:{numerator:'1000',denominator:'1'}};history.push(snap('OPENING',10,1000));}
        if(createCount===1){await route.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});return;}
        data={product_id:product.product_id,stock_revision:1,warehouse_quantity:10};
      }else if(tail==='minibar/products/product-1/receipts'){
        if(conflict){conflict=false;product.stock_revision=2;product.warehouse_quantity=12;history.push(snap('PURCHASE',2,500));product.average_cost={numerator:'11000',denominator:'12'};await route.fulfill({status:409,json:{code:'REVISION_CONFLICT'}});return;}
        assert.equal(body.expected_revision,product.stock_revision);product.stock_revision++;product.warehouse_quantity+=body.quantity;history.push(snap('PURCHASE',body.quantity,body.unit_cost_mnt));product.average_cost={numerator:String(history.reduce((sum,r)=>sum+r.quantity*r.unit_cost_mnt,0)),denominator:String(product.warehouse_quantity)};data={stock_revision:product.stock_revision};
      }else if(tail==='minibar/products/product-1/ledger'){
        if(ledgerFail){ledgerFail=false;await route.fulfill({status:503,json:{code:'SERVICE_UNAVAILABLE'}});return;}
        data={items:history,next_after:null};
      }
      await route.fulfill({json:data});
    });
    const ready=()=>page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false');
    const login=async()=>{
      await page.goto('about:blank');await page.goto(origin+'/reception#inventory');await page.getByLabel('Буудлын код').fill('test-hotel');
      await page.getByLabel('Имэйл',{exact:true}).fill('manager@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');
      await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await ready();
    };
    await login();assert.match(await page.locator('#content').textContent(),/Бүтээгдэхүүн бүртгэлгүй/);
    await page.getByRole('button',{name:'Бүтээгдэхүүн бүртгэх',exact:true}).click();
    const form=page.locator('form').filter({has:page.getByRole('heading',{name:'Шинэ бүтээгдэхүүн'})});
    const send=form.getByRole('button',{name:'Бүтээгдэхүүн бүртгэх',exact:true});await send.click();
    assert.equal(await page.evaluate(()=>document.activeElement.name),'name');
    await page.getByLabel('Бүтээгдэхүүний нэр',{exact:true}).fill('Ус');
    await page.getByRole('link',{name:'Удирдлага',exact:true}).click();await page.locator('#discard').waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>document.activeElement.id),'keep');await page.keyboard.press('Escape');
    assert.equal(await page.getByLabel('Бүтээгдэхүүний нэр',{exact:true}).inputValue(),'Ус');
    await page.getByLabel('Бүтээгдэхүүний ангилал').fill('Ундаа');await page.getByLabel('Худалдах нэгж үнэ (₮)').fill('3000');
    await page.getByLabel('Худалдан авалтын нэгж өртөг (₮)').fill('1000');await page.getByLabel('Агуулахын анхны тоо').fill('10');
    await page.getByLabel('Эхлэх төлөв').focus();await page.keyboard.press('Space');await page.keyboard.press('Escape');
    await send.click();await form.locator('.result.error').waitFor();assert.equal(await page.getByLabel('Агуулахын анхны тоо').inputValue(),'10');
    await send.click();await form.evaluate(f=>f.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    await page.getByRole('button',{name:'Орлого бүртгэх',exact:true}).waitFor();assert.equal(createCount,2);assert.doesNotMatch(await page.locator('.record').textContent(),/ойролцоо/);
    assert.deepEqual(requests.filter(r=>r.body&&r.tail==='minibar/products').map(r=>r.body.idempotency_key),Array(2).fill(requests.find(r=>r.body).body.idempotency_key));
    const receive=async()=>{await page.getByRole('button',{name:'Орлого бүртгэх',exact:true}).click();await page.getByLabel('Хүлээн авсан тоо').fill('5');await page.getByLabel('Худалдан авалтын нэгж өртөг (₮)').fill('1000');await page.getByRole('button',{name:'Орлого баталгаажуулах'}).click();await page.waitForFunction(()=>!document.querySelector('form[aria-busy="true"]')&&document.querySelector('#content').getAttribute('aria-busy')==='false');};
    await receive();await page.locator('.result.error').waitFor();assert.match(await page.locator('.result.error').textContent(),/Мэдээлэл өөрчлөгджээ/);
    await page.locator('#refresh').click();await page.locator('#discard').waitFor({state:'visible'});await page.locator('#leave').click();await ready();
    await receive();await page.getByText('Агуулахын орлого бүртгэгдлээ.',{exact:true}).waitFor();
    await receive();await page.getByText('Агуулахын орлого бүртгэгдлээ.',{exact:true}).waitFor();assert.equal(product.warehouse_quantity,22);assert.match(await page.locator('.record').textContent(),/ойролцоо/);
    ledgerFail=true;await page.getByRole('button',{name:'Хөдөлгөөний түүх'}).click();await page.getByRole('button',{name:'Түүхийг дахин ачаалах'}).click();
    await page.getByRole('table').waitFor();assert.equal(await page.getByRole('row').count(),5);
    await page.setViewportSize({width:320,height:760});await page.emulateMedia({reducedMotion:'reduce'});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    assert(await page.locator('.record button').evaluateAll(buttons=>buttons.every(b=>b.getBoundingClientRect().right<=b.closest('.record').getBoundingClientRect().right+1)));
    assert.equal(await page.locator('form:not([novalidate])').count(),0);assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
    fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/minibar-mobile.png',fullPage:true});
    await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'artifacts/minibar-desktop.png',fullPage:true});
    fs.writeFileSync('artifacts/minibar-requests.json',JSON.stringify(requests));
    packageMnt=20000;const before=requests.length;await login();assert.equal(await page.getByRole('link',{name:'Агуулах',exact:true}).count(),0);assert.equal(requests.length,before);
    packageMnt=30000;role='RECEPTION';await login();assert.equal(await page.getByRole('link',{name:'Агуулах',exact:true}).count(),0);
    assert.deepEqual(problems,[]);console.log('Minibar browser checks passed: create/retry, stock conflict, ledger recovery, package/role UI, keyboard, mobile and privacy.');
  }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
