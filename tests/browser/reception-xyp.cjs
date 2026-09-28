const {chromium}=require('playwright');
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../../src/prsystem/static');
// RC-DEC-046 follow-ups: every ХУР lookup outcome, the manual fallback payload and re-pulling an expired lookup.
(async()=>{
 const server=http.createServer((req,res)=>{const file=req.url.includes('/assets/')?path.basename(req.url):'reception.html';res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(root,file)));}).listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
 const browser=await chromium.launch({headless:true,...(process.env.PRSYSTEM_BROWSER_PATH?{executablePath:process.env.PRSYSTEM_BROWSER_PATH,args:['--no-sandbox']}: {})});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),origin=`http://127.0.0.1:${server.address().port}`;
  const requests=[],problems=[];let lookups=0,reject=null;page.on('pageerror',e=>problems.push(e.message));
  const room={room_id:'room-1',number:'101',floor:'1',category_id:'category-1',category_name:'Стандарт',status:'ACTIVE',cleaning_state:'CLEAN',revision:1,minibar_mode:'OFF',tariffs:{}};
  const overview=()=>({account_id:'worker',roles:['RECEPTION'],package_mnt:30000,mode:'MOCK_CASH_LEDGER',limit:50,staff:[{account_id:'worker',email:'worker@example.com',roles:['RECEPTION']}],drawers:[{drawer_id:'drawer-1',name:'Үндсэн касс',unused:false}],shifts:[{shift_id:'shift-1',owner_id:'worker',drawer_id:'drawer-1',state:'OPEN',opened_at:'2026-09-07T00:00:00Z',review_state:'NOT_SUBMITTED'}],funding:[],custodies:[],qrs:[],inspections:[],cleaning:[]});
  // Outcome by РД; any other number is FOUND. ЕЕ… imitates an older server that sends no reason.
  const outcomes={'АБ85020311':{status:'NOT_FOUND'},'ББ90010211':{status:'UNAVAILABLE',reason:'NOT_CONFIGURED'},'ВВ90010211':{status:'UNAVAILABLE',reason:'TIMEOUT'},'ГГ90010211':{status:'UNAVAILABLE',reason:'PROVIDER_ERROR'},'ДД90010211':{status:'UNAVAILABLE',reason:'INVALID_EVIDENCE'},'ЕЕ90010211':{status:'UNAVAILABLE'}};
  await page.route('**/auth/**',async route=>{const url=new URL(route.request().url());await route.fulfill({json:url.pathname==='/auth/login'?{access_token:'test-session'}:url.pathname==='/auth/me'?{roles:['RECEPTION']}:{}});});
  await page.route('**/hotels/**',async route=>{
   const url=new URL(route.request().url()),tail=url.pathname.replace('/hotels/test-hotel/',''),body=route.request().postDataJSON();requests.push({tail,body,method:route.request().method()});
   let data={};
   if(tail==='operations')data=overview();
   else if(tail==='rooms')data=[room];else if(tail==='room-categories')data=[{category_id:'category-1',name:'Стандарт',status:'ACTIVE',revision:1}];
   else if(['stays/active','bookings','handovers','cleaning/checkouts'].includes(tail))data=[];
   else if(tail==='guest-identity/xyp-lookups'){assert.equal(body.consent,true);lookups+=1;data={lookup_id:`lookup-${lookups}`,expires_at:'2026-09-07T01:15:00Z',...(outcomes[body.document_number]||{status:'FOUND',citizen:{family_name:'Бат',given_name:'Болд',date_of_birth:'1990-01-02',nationality:'MN'}})};}
   else if(tail==='stays/check-in'){if(reject){const code=reject;reject=null;await route.fulfill({status:409,json:{code}});return;}data={stay_id:'stay-1',room_id:'room-1',guest_access_code:'123456'};}
   await route.fulfill({json:data});
  });
  const open=async()=>{await page.goto(origin+'/reception');await page.getByLabel('Буудлын код').fill('test-hotel');await page.getByLabel('Имэйл',{exact:true}).fill('worker@example.com');await page.getByLabel('Нууц үг',{exact:true}).fill('Password 2026!');await page.getByRole('button',{name:'Нэвтрэх',exact:true}).click();await page.locator('#app').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#content').getAttribute('aria-busy')==='false');
   await page.getByRole('button',{name:'Шууд ирсэн зочин бүртгэх',exact:true}).click();await page.getByRole('button',{name:'Зочны мэдээлэл оруулах',exact:true}).click();};
  const consent=()=>page.getByLabel('Зочин ХУР-аас мэдээлэл авахыг зөвшөөрсөн',{exact:false});
  const pull=async number=>{await page.getByLabel('Регистрийн дугаар',{exact:true}).fill(number);await consent().check();await page.getByRole('button',{name:'ХУР-аас татах',exact:true}).click();};
  const focused=()=>page.evaluate(()=>document.activeElement.textContent);
  const count=name=>page.getByRole('button',{name,exact:true}).count();
  const deposit=async()=>{await page.getByLabel('Бэлнээр авсан барьцаа (₮)',{exact:false}).fill('60000');await page.getByLabel('Бэлэн барьцааг биечлэн авсан',{exact:false}).check();};
  const submit=()=>page.getByRole('button',{name:'Зочны бүртгэл баталгаажуулах',exact:true}).click();
  const checkins=()=>requests.filter(r=>r.tail==='stays/check-in');
  const verified='ХУР-аар баталгаажсан: Бат Болд · 1990-01-02 · MN';

  // Spec §5.1: one message per outcome; retry only where asking again can help.
  await open();
  for(const [number,message,retry] of [['АБ85020311','ХУР-д энэ РД-ээр мэдээлэл олдсонгүй.',0],['ВВ90010211','ХУР хугацаандаа хариулсангүй.',1],['ГГ90010211','ХУР-тай холбогдож чадсангүй.',1],['ДД90010211','ХУР-ын мэдээлэл РД-тэй таарахгүй байна.',0],['ЕЕ90010211','ХУР-тай холбогдож чадсангүй.',1]]){
   await pull(number);await page.getByText(message,{exact:true}).waitFor();
   assert.equal(await focused(),message,number);assert.equal(await count('Дахин оролдох'),retry,number);assert.equal(await count('Гараар бүртгэх'),1,number);
   await page.getByRole('button',{name:'Өөр РД оруулах',exact:true}).click();await page.getByLabel('Регистрийн дугаар',{exact:true}).waitFor();
  }

  // NOT_CONFIGURED opens the manual form at once; the manual payload carries the failed lookup and its РД.
  await pull('ББ90010211');await page.getByText('ХУР холбогдоогүй байна. Гараар бүртгэнэ үү.',{exact:true}).waitFor();await page.getByLabel('Овог',{exact:true}).waitFor();
  assert.equal(await focused(),'Шууд ирсэн зочин бүртгэх');assert.equal(await count('Дахин оролдох'),0);assert.equal(await count('Гараар бүртгэх'),0);
  await page.getByLabel('Овог',{exact:true}).fill('Бат');await page.getByLabel('Нэр',{exact:true}).fill('Болд');await page.getByLabel('Төрсөн огноо',{exact:true}).fill('1990-01-02');await deposit();
  await submit();await page.getByRole('button',{name:'Байрлалтыг нээх',exact:true}).waitFor();
  assert.deepEqual(checkins().at(-1).body.guest,{identity_type:'MN_REG_NO',xyp_lookup_id:`lookup-${lookups}`,document_number:'ББ90010211',family_name:'Бат',given_name:'Болд',date_of_birth:'1990-01-02',nationality:'MN'});

  // Spec §5.2: an expired FOUND lookup is pulled again without losing what Reception typed.
  await open();await pull('АБ90010211');await page.getByText(verified,{exact:true}).waitFor();const first=`lookup-${lookups}`;await deposit();
  reject='XYP_LOOKUP_EXPIRED';await submit();await page.getByText('ХУР-ын хайлтын хугацаа дууссан. Дахин татна уу.',{exact:true}).waitFor();
  // One re-pull form however it is asked for; closing it keeps the message, the button and the focus.
  const expired='ХУР-ын хайлтын хугацаа дууссан. Дахин татна уу.',repullButton=()=>page.getByRole('button',{name:'ХУР-аас дахин татах',exact:true}),repullForm=()=>page.locator('form').filter({has:page.getByRole('heading',{name:'ХУР-аас дахин татах',exact:true})});
  const active=()=>page.evaluate(()=>`${document.activeElement.tagName} ${document.activeElement.textContent}`);
  await repullButton().dblclick();await page.getByLabel('Регистрийн дугаар',{exact:true}).waitFor();assert.equal(await repullForm().count(),1);
  const sent=checkins().length;reject='XYP_LOOKUP_EXPIRED';await submit();for(let i=0;i<100&&checkins().length===sent;i++)await page.waitForTimeout(50);await page.getByText(expired,{exact:true}).waitFor();
  await repullButton().click();assert.equal(await repullForm().count(),1);assert.equal(await active(),'H2 ХУР-аас дахин татах');
  await repullForm().getByRole('button',{name:'Маягтыг хаах',exact:true}).click();await page.getByLabel('Регистрийн дугаар',{exact:true}).waitFor({state:'detached'});
  assert.equal(await page.getByText(expired,{exact:true}).count(),1);assert.equal(await active(),'BUTTON ХУР-аас дахин татах');
  await repullButton().click();await page.getByLabel('Регистрийн дугаар',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Регистрийн дугаар',{exact:true}).inputValue(),'АБ90010211');assert.equal(await consent().isChecked(),false);
  await consent().check();await page.getByRole('button',{name:'ХУР-аас татах',exact:true}).click();await page.getByLabel('Регистрийн дугаар',{exact:true}).waitFor({state:'detached'});
  assert.equal(await focused(),verified);assert.equal(await page.getByLabel('Бэлнээр авсан барьцаа (₮)',{exact:false}).inputValue(),'60000');
  assert.equal(await page.getByText(expired,{exact:true}).count(),0);assert.equal(await repullButton().count(),0);
  await submit();await page.getByRole('button',{name:'Байрлалтыг нээх',exact:true}).waitFor();
  assert.equal(checkins().at(-2).body.guest.xyp_lookup_id,first);assert.notEqual(first,`lookup-${lookups}`);
  assert.deepEqual(checkins().at(-1).body.guest,{identity_type:'MN_REG_NO',xyp_lookup_id:`lookup-${lookups}`});assert.equal(checkins().at(-1).body.deposit.amount_mnt,60000);

  // Re-pull that is not FOUND closes the stale form and continues with the normal outcome.
  await open();await pull('АБ90010211');await page.getByText(verified,{exact:true}).waitFor();await deposit();
  reject='XYP_LOOKUP_EXPIRED';await submit();await page.getByRole('button',{name:'ХУР-аас дахин татах',exact:true}).click();
  await page.getByLabel('Регистрийн дугаар',{exact:true}).fill('ГГ90010211');await consent().check();await page.getByRole('button',{name:'ХУР-аас татах',exact:true}).click();
  await page.getByText('ХУР-тай холбогдож чадсангүй.',{exact:true}).waitFor();assert.equal(await focused(),'ХУР-тай холбогдож чадсангүй.');
  assert.equal(await page.getByLabel('Бэлнээр авсан барьцаа (₮)',{exact:false}).count(),0);assert.equal(await count('Дахин оролдох'),1);

  // USED: the lookup already produced a stay; never offer a re-pull that could register the guest twice.
  await open();await pull('АБ90010211');await page.getByText(verified,{exact:true}).waitFor();await deposit();
  reject='XYP_LOOKUP_USED';await submit();await page.getByText('Энэ хайлтаар аль хэдийн бүртгэсэн. Идэвхтэй байрлалтуудаа шалгана уу.',{exact:true}).waitFor();
  assert.equal(await count('ХУР-аас дахин татах'),0);

  fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/reception-xyp-requests.json',JSON.stringify(requests));
  assert.deepEqual(problems,[]);assert.equal(await page.locator('form:not([novalidate])').count(),0);
  console.log('Reception ХУР checks passed: outcome messages, focus, manual fallback payload, expired re-pull and USED guard.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
