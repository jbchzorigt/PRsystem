'use strict';
(() => {
  const $=s=>document.querySelector(s), enc=encodeURIComponent;
  let token='',tenant='',overview=null,roles=[],packageMnt=0,view='guests',generation=0,dirty=false,pending=false;
  let rooms=[],categories=[],stays=[],bookings=[],roomAfter='',stayAfter='',selected=null,inventoryAfter='',templateAfter='',templateSelection=null;
  const money=n=>`${new Intl.NumberFormat('mn-MN').format(n)} ₮`;
  const time=v=>{if(!v)return '—';const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Ulaanbaatar',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(v)).map(x=>[x.type,x.value]));return `${p.year}.${p.month}.${p.day} ${p.hour}:${p.minute}`;};
  const portalMode=location.pathname==='/booking'?'booker':location.pathname==='/platform/booking'?'finance':null;
  const names={templates:'Минибарын загвар',inventory:'Агуулах',online:'Онлайн захиалга',guests:'Зочин бүртгэх',rooms:'Өрөөнүүд',payments:'Төлбөр',restaurant:'Ресторан',shift:'Ээлж',manager:'Удирдлага',cleaning:'Цэвэрлэгээ'};
  const labels={IN_PROGRESS:'Тооллого, тулгалт хийж буй',BLOCKED_VARIANCE:'Тооллогын зөрүүтэй',BLOCKED_STOCK:'Нөөц хүрэлцэхгүй',SCHEDULED_AFTER_STAY:'Зочны дараа тохируулах',READY_FOR_RECONCILIATION:'Тооллого, тулгалт хүлээж буй',HOLDING:'Төлбөр хүлээж буй',CHECKED_IN:'Байрлаж буй',NO_SHOW:'Ирээгүй',CANCELLED_GUEST:'Зочин цуцалсан',CANCELLED_HOTEL:'Буудал цуцалсан',EXPIRED:'Хугацаа дууссан',UNKNOWN:'Тулгалт шаардлагатай',FAILED:'Амжилтгүй',NO_PAYABLE:'Шилжүүлэх үлдэгдэлгүй',ELIGIBLE:'Шилжүүлэгт бэлэн',HELD:'Тулгалт хүлээсэн',NOT_ELIGIBLE:'Хугацаа болоогүй',BATCHED:'Багцалсан',VOIDED:'Багц цуцалсан',ACTIVE:'Идэвхтэй',INACTIVE:'Идэвхгүй',RETIRING:'Хаахаар хүлээж буй',DIRTY:'Бохир',CLEANING:'Цэвэрлэж буй',CLEAN:'Цэвэр',OPEN:'Нээлттэй',CLOSED:'Хаасан',SUBMITTED:'Хүлээлгэн өгсөн',ACCEPTED:'Хүлээн авсан',RETURNED:'Буцаасан',PENDING:'Хүлээгдэж буй',REFUNDING:'Буцаалт хүлээгдэж буй',CONFIRMED:'Баталгаажсан',APPLIED:'Ашигласан',CANCELLED:'Цуцалсан',SUCCEEDED:'Амжилттай',COMPLETED:'Дууссан',RESERVED:'Нөөцөлсөн',RELEASED:'Чөлөөлсөн',APPROVED:'Зөвшөөрсөн',REJECTED:'Татгалзсан',MANAGER_REQUIRED:'Менежерийн хяналт',ADMIN_REQUIRED:'Админы хяналт',NOT_REQUIRED:'Хяналт шаардахгүй',NOT_SUBMITTED:'Илгээгээгүй',DISPUTED:'Маргаантай',REQUESTED:'Тайлан хүлээж буй',REPORTED:'Тайлан ирсэн',CASH:'Бэлэн',MANUAL_POS:'Карт / POS',QPAY:'QPay',KHAAN:'Хаан банк',ROOM:'Өрөө',MINIBAR:'Минибар',PAYMENT:'Төлбөр',DEPOSIT:'Барьцаа',REFILL:'Нөхөн дүүргэх',COUNT:'Тоолох',RETURN:'Буцаах',HOURLY:'Цагаар',NIGHTLY:'Хоногоор',READY:'Бэлэн',PREPARING:'Бэлтгэж буй',PAID_PENDING:'Төлсөн, хүлээгдэж буй'};
  const errors={RECONCILIATION_NOT_READY:'Өмнөх байрлалт, төлбөр эсвэл минибарын ажил дуусаагүй байна.',MOCK_INVENTORY_NOT_SUPPORTED:'Туршилтын минибарын барааг бодит агуулахад шилжүүлэхгүй. Туршилтын тохиргоог эхлээд тусад нь шийднэ үү.',COUNT_REQUIRED:'Өрөөний бүх барааг тоолж батална уу.',COUNT_VARIANCE:'Бодит тоо бүртгэлтэй зөрсөн. Менежерт мэдэгдэнэ үү.',CANONICAL_TASK_REQUIRED:'Минибарын тохиргооны ажлаас энэ тооллогыг нээнэ үү.',CONFIGURATION_PENDING:'Минибарын тохиргооны хүсэлт хүлээгдэж байна. Өрөөний тохиргоог нээж шалгана уу.',CONFIGURATION_UNCHANGED:'Өрөөний минибар аль хэдийн унтраалттай байна.',CONFIGURATION_TERMINAL:'Энэ хүсэлт цуцлагдсан байна. Жагсаалтаа шинэчилнэ үү.',TEMPLATE_NOT_ACTIVE:'Загвар идэвхгүй байна. Идэвхтэй загвар сонгоно уу.',TEMPLATE_VERSION_IMMUTABLE:'Нийтэлсэн бүрдлийг засахгүй. Шинэ ноорог хувилбар үүсгэнэ үү.',TEMPLATE_EMPTY:'Нийтлэхээс өмнө дор хаяж нэг бүтээгдэхүүн нэмнэ үү.',TEMPLATE_NOT_PUBLISHED:'Эхлээд энэ хувилбарыг нийтэлнэ үү.',PRODUCT_NOT_ACTIVE:'Зөвхөн идэвхтэй бүтээгдэхүүн сонгоно уу. Загварын бүрдэл болон бүтээгдэхүүний төлөвийг шалгана уу.',PACKAGE_REQUIRED:'Таны багцад энэ боломж байхгүй.',STOCK_SOURCE_NOT_FOUND:'Нөөцийн эх үүсвэр олдсонгүй. Мэдээллээ шинэчилнэ үү.',INVALID_CREDENTIALS:'Утас, нууц үг эсвэл баталгаажуулах кодоо шалгана уу.',RATE_LIMITED:'Олон удаа оролдсон байна. Түр хүлээгээд дахин оролдоно уу.',BOOKING_ROOM_AVAILABLE:'Ижил эсвэл өндөр ангиллын боломжит өрөөг эхлээд онооно уу.',NO_SHOW_CUTOFF_NOT_PASSED:'Ирэх өдрийн 23:59:59 өнгөрсний дараа ирээгүй төлөвт шилжүүлнэ.',BOOKING_CAPACITY_UNAVAILABLE:'Сонгосон хугацааны сул өрөө дууссан эсвэл захиалга авахгүй байна.',MFA_REQUIRED:'Шинэ MFA кодоор эрхээ баталгаажуулна уу.',SETTLEMENT_REFRESH_REQUIRED:'Тулгалтын дүн өөрчлөгдсөн. Илгээгээгүй багцаа цуцалж дахин тооцно уу.',SETTLEMENT_HELD:'Шийдэгдээгүй санхүүгийн тулгалт байна.',PAYOUT_PENDING:'Өмнөх шилжүүлгийн төлөвийг эхлээд тулгана уу.',PAYOUT_TERMINAL:'Энэ шилжүүлэг эцсийн төлөвт орсон байна.',REVISION_CONFLICT:'Мэдээлэл өөрчлөгджээ. Шинэчилж, дүнгээ дахин шалгана уу.',FORBIDDEN:'Энэ үйлдлийг хийх эрх алга.',SUBSCRIPTION_EXPIRED:'Багцын хугацаа дууссан. Зөвхөн өмнө эхэлсэн ажлыг дуусгах эрх үйлчилнэ.',UNAUTHENTICATED:'Нэвтрэх эрх дууссан. Дахин нэвтэрнэ үү.',OPEN_SHIFT_REQUIRED:'Өөрийн нээлттэй ээлж шаардлагатай.',CHECKOUT_FINANCE_PENDING:'Төлбөр, барьцаа, хүлээгдэж буй үйлдлээ эхлээд шийдвэрлэнэ үү.',MINIBAR_REPORT_REQUIRED:'Минибарын баталгаажсан тайлан шаардлагатай.',MINIBAR_REPORT_LOCKED:'Төлбөр орсон тайланг энэ үйлдлээр засахгүй.',ROOM_NOT_READY:'Өрөөний цэвэрлэгээ, хугацаа, минибарын бэлэн байдлыг шалгана уу.',RESTAURANT_ACK_REQUIRED:'Дуусаагүй захиалга бүрийн сонголт, зочинд мэдээлсэн баталгааг оруулна уу.',GUARDIAN_REQUIRED:'18 нас хүрээгүй зочны асран хамгаалагчийг бүртгэнэ үү.',INVALID_GUEST_IDENTITY:'Зочны баримт болон төрсөн огноо тохирч байгаа эсэхийг шалгана уу.',AMENDMENT_PENDING:'Ирсэн цагийн засварын шийдвэрийг хүлээнэ үү.',INSUFFICIENT_CASH:'Кассын боломжит үлдэгдэл хүрэлцэхгүй.',PHYSICAL_COUNT_REQUIRED:'Системийн дүнг харахын өмнө биечлэн тоолж бүртгэнэ үү.',SERVICE_UNAVAILABLE:'Үйлчилгээ түр хариу өгөхгүй байна. Үр дүн тодорхойгүй тул энэ маягтаас дахин оролдож болно.',GUEST_PROVIDER_UNAVAILABLE:'Төлбөрийн үйлчилгээ энэ орчинд холбогдоогүй.',CHARGE_OVERPAYMENT:'Үлдэгдлээс давсан дүн оруулсан байна.',RECOUNT_REQUIRED:'Зөрүүтэй тул дахин биечлэн тоолно уу.'};
  function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n;}
  function say(text,error=false){$('#status').textContent=text;$('#status').className=error?'error':'';}
  function btn(text,fn,cls='secondary'){const b=node('button',text,cls);b.type='button';b.addEventListener('click',fn);return b;}
  function role(r){return roles.includes(r);} function manager(){return role('MANAGER')||(role('MANAGER_PLUS')&&packageMnt===30000);}
  function path(s){return `/hotels/${enc(tenant)}/${s}`;} function stayPath(s,suffix){return path(`stays/${enc(s)}/${suffix}`);}
  async function api(url,body,method='POST',access=token){
    const requestToken=access,controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try { const response=await fetch(url,{method:body===undefined?'GET':method,headers:{...(access?{Authorization:`Bearer ${access}`} : {}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,cache:'no-store'});
      if(response.headers.get('X-PRsystem-Mode')==='MOCK_ONLY')$('#mode').hidden=false;
      const data=response.status===204?{}:await response.json();
      if(!response.ok){const e=new Error(errors[data.code]||(response.status===422?'Оруулсан талбар, дүн, хугацаагаа шалгана уу.':'Үйлдлийг бүртгэж чадсангүй. Мэдээллээ шинэчлээд дахин шалгана уу.'));e.code=data.code;e.status=response.status;if(response.status===401&&token&&token===requestToken){token='';dirty=false;pending=false;if(location.pathname==='/guest/entry'){$('#login').replaceChildren(node('h1','Нэвтрэх эрх дууссан'),node('p','Өрөөний QR-г дахин уншуулж, Reception-оос шинэ код авна уу.'));}else if(portalMode)portalHome('Нэвтрэх эрх дууссан. Дахин нэвтэрнэ үү.');else showLogin('Нэвтрэх эрх дууссан. Дахин нэвтэрнэ үү.');}throw e;}return data;
    } catch(e){if(!e.code)e.message='Холболт тасарсан эсвэл хугацаа хэтэрсэн. Үр дүн тодорхойгүй; энэ маягтаас дахин оролдоно уу.';throw e;} finally{clearTimeout(timer);}
  }
  const field=(name,label,type='text',extra={})=>({name,label,type,...extra});
  const amount=(name='amount_mnt',label='Дүн (₮)',value)=>field(name,label,'number',{min:1,value});
  const reason=()=>field('reason','Шалтгаан','textarea',{max:1000});
  const option=(value,label)=>[value,label];
  const channels=()=>['CASH','MANUAL_POS','QPAY','KHAAN'].map(v=>option(v,labels[v]));
  function form(parent,title,fields,submit,action,opts={}){
    const f=node('form');f.noValidate=true;f.append(node('h2',title));const controls=new Map(),id=crypto.randomUUID();let key=crypto.randomUUID(),fingerprint='',busy=false;
    for(const spec of fields){const wrap=node('div',undefined,'field'),input=node(spec.type==='select'?'select':spec.type==='textarea'?'textarea':'input');input.id=`f-${id}-${spec.name}`;input.name=spec.name;
      if(input.tagName==='INPUT')input.type=spec.type;input.required=!spec.optional;input.autocomplete=spec.autocomplete||'off';
      if(spec.type==='select'){for(const [v,label] of spec.options||[]){const o=node('option',label);o.value=v;input.append(o);}}
      if(spec.type==='checkbox')input.checked=spec.value===true;else if(spec.value!==undefined&&spec.value!==null)input.value=String(spec.value);
      if(spec.accept)input.accept=spec.accept;if(spec.decimal)input.step='any';if(spec.min!==undefined)input.min=spec.min;if(spec.max!==undefined)input.maxLength=spec.max;
      const label=node('label',spec.label+(spec.optional?' (сонголттой)':''));label.htmlFor=input.id;const error=node('p','', 'error');error.id=input.id+'-error';input.setAttribute('aria-describedby',error.id);
      wrap.append(label,input);
      if(spec.type==='password'){const reveal=btn('Нууц үг харуулах',()=>{const show=input.type==='password';input.type=show?'text':'password';reveal.textContent=show?'Нууц үг нуух':'Нууц үг харуулах';reveal.setAttribute('aria-pressed',String(show));});reveal.setAttribute('aria-pressed','false');wrap.append(reveal);}
      wrap.append(error);f.append(wrap);controls.set(spec.name,{input,error,spec});
      input.addEventListener('input',()=>{if(!opts.login)dirty=true;error.textContent='';input.removeAttribute('aria-invalid');});
    }
    const status=node('p','', 'result');status.setAttribute('role','status');const send=node('button',submit,'primary');send.type='submit';const actions=node('div',undefined,'actions');actions.append(send);if(!opts.login)actions.append(btn('Маягтыг хаах',()=>guard(()=>{f.remove();dirty=false;})));
    f.append(status,actions);parent.append(f);
    f.addEventListener('submit',async event=>{event.preventDefault();if(busy||pending)return;const values={};let first=null;
      for(const {input,error,spec} of controls.values()){const raw=spec.type==='checkbox'?input.checked:spec.type==='file'?(input.files[0]||''):spec.type==='password'?input.value:input.value.trim();let message='';
        if(!spec.optional&&(raw===''||raw===false))message='Энэ талбарыг бөглөнө үү.';
        if(raw!==''&&spec.type==='number'&&(!(spec.decimal?Number.isFinite(Number(raw)):Number.isSafeInteger(Number(raw)))||Number(raw)<(spec.min??0)))message='Зөв бүхэл дүн оруулна уу.';
        if(raw!==''&&spec.type==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw))message='Имэйл хаягаа шалгана уу.';
        if(message){error.textContent=message;input.setAttribute('aria-invalid','true');first??=input;}
        if(raw!==''||!spec.optional)values[spec.name]=spec.type==='number'?Number(raw):raw;
      }
      if(first){status.textContent='Алдаатай талбарыг засна уу.';first.focus();return;}
      const serialized=JSON.stringify(values,(_,v)=>v instanceof File?{name:v.name,size:v.size,modified:v.lastModified}:v);if(fingerprint&&serialized!==fingerprint)key=crypto.randomUUID();fingerprint=serialized;
      busy=true;pending=true;send.disabled=true;f.setAttribute('aria-busy','true');status.textContent='Бүртгэж байна…';
      try{const result=await action({...values,idempotency_key:key});if(!f.isConnected)return;dirty=false;status.textContent='Серверт бүртгэгдлээ.';key=crypto.randomUUID();fingerprint='';
        for(const {input,spec} of controls.values())if(spec.type==='password'){input.value='';input.type='password';}
        if(opts.success)await opts.success(result,f,status);else {showResult(status,result);if(!portalMode)await reloadOverview();}
      }catch(e){if(f.isConnected){status.textContent=e.message;status.className='result error';}}finally{busy=false;pending=false;send.disabled=false;f.setAttribute('aria-busy','false');}
    });return f;
  }
  function showResult(parent,result){parent.replaceChildren(node('p','Серверт бүртгэгдлээ.'));
    const safe=['state','status','review_state','variance','actual','expected','sender_actual','counts_match','amount_mnt','opening_actual','minibar_report_required'];
    const titles={state:'Төлөв',status:'Төлөв',review_state:'Хяналт',variance:'Зөрүү',actual:'Тоолсон дүн',expected:'Системийн дүн',sender_actual:'Өгөгчийн тооллого',counts_match:'Тооллого таарсан',amount_mnt:'Дүн',opening_actual:'Эхлэх дүн',minibar_report_required:'Минибарын тайлан шаардлагатай'};
    for(const k of safe)if(result[k]!==undefined&&result[k]!==null)parent.append(node('p',`${titles[k]}: ${labels[result[k]]??(typeof result[k]==='boolean'?(result[k]?'Тийм':'Үгүй'):result[k])}`));
    if(result.code||result.guest_access_code){parent.append(node('p','Зочинд өгөх нэг удаагийн код · 10 минут хүчинтэй'));parent.append(node('p',result.code||result.guest_access_code,'secret'));}
    if(result.qr_token){parent.append(node('p','Өрөөний шинэ QR нэвтрэх түлхүүр. Зөвхөн тухайн өрөөнд байршуулна.'));parent.append(node('p',result.qr_token,'secret'));}
  }
  function guard(next){if(pending){say('Одоо бүртгэж буй үйлдлийн хариуг хүлээнэ үү.',true);return;}if(!dirty){next();return;}
    const dialog=$('#discard'),origin=document.activeElement;dialog.showModal();$('#keep').focus();
    const close=()=>{dialog.close();origin?.focus();};$('#keep').onclick=close;$('#leave').onclick=()=>{dirty=false;dialog.close();next();};
  }
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  window.addEventListener('pagehide',()=>{generation++;dirty=false;pending=false;geo=null;portalQuery=null;customerPhone='';token='';tenant='';$('#content').replaceChildren();$('#login').replaceChildren();});
  function showLogin(message=''){generation++;$('#app').hidden=true;$('#logout').hidden=true;$('#login').hidden=false;$('#content').replaceChildren();$('#login').replaceChildren();overview=null;roles=[];selected=null;rooms=[];stays=[];categories=[];bookings=[];inventoryAfter='';templateAfter='';templateSelection=null;
    form($('#login'),'Ажилтнаар нэвтрэх',[field('tenant_id','Буудлын код'),field('email','Имэйл','email',{autocomplete:'username'}),field('password','Нууц үг','password',{autocomplete:'current-password'})],'Нэвтрэх',async v=>api('/auth/login',{tenant_id:v.tenant_id,email:v.email,password:v.password}),{login:true,success:async(r,f,status)=>{token=r.access_token;tenant=f.elements.tenant_id.value.trim();const me=await api('/auth/me');roles=me.roles;await reloadOverview();$('#login').hidden=true;$('#app').hidden=false;$('#logout').hidden=false;f.remove();const desired=location.hash.slice(1),allowed=Array.from($('#navigation').querySelectorAll('a')).map(a=>a.hash.slice(1));await navigate(allowed.includes(desired)?desired:role('RECEPTION')?'guests':manager()?(overview.completion_only?'guests':'manager'):role('HOTEL_ADMIN')?'shift':'cleaning');}});
    if(message)$('#login').prepend(node('p',message,'notice'));
  }
  async function reloadOverview(){const seq=generation,data=await api(path('operations'));if(seq!==generation)return;overview=data;roles=overview.roles;packageMnt=overview.package_mnt;$('#mode').hidden=overview.mode!=='MOCK_CASH_LEDGER';navigation();}
  function navigation(){const nav=$('#navigation');nav.replaceChildren();let links=[];if(role('RECEPTION')||manager())links=['guests','rooms','payments','online',...(packageMnt===30000?['restaurant']:[])];if(role('RECEPTION')||manager()||role('HOTEL_ADMIN'))links.push('shift');if(manager()&&!overview.completion_only)links.push('manager');if(manager()&&[25000,30000].includes(packageMnt)&&!overview.completion_only)links.push('inventory','templates');if(role('CLEANER')||manager())links.push('cleaning');
    for(const name of links){const a=node('a',names[name]);a.href=`#${name}`;if(name===view)a.setAttribute('aria-current','page');a.onclick=e=>{e.preventDefault();guard(()=>navigate(name));};nav.append(a);}
  }
  async function navigate(next){const seq=++generation;view=next;dirty=false;history.replaceState(null,'',`#${next}`);document.title=`${names[next]} — PRsystem`;navigation();$('#page-title').textContent=names[next];$('#page-title').focus();$('#content').replaceChildren();$('#content').setAttribute('aria-busy','true');say('Мэдээлэл ачаалж байна…');
    try{await render(next,seq);if(seq===generation)say(overview.completion_only?'Багцын хугацаа дууссан. Зөвхөн хугацаа дуусахаас өмнө эхэлсэн ажлууд харагдана.':'Мэдээлэл шинэчлэгдсэн.');}catch(e){if(seq===generation)say(e.message,true);}finally{if(seq===generation)$('#content').setAttribute('aria-busy','false');}
  }
  $('#refresh').onclick=()=>guard(async()=>{try{await reloadOverview();await navigate(view);}catch(e){say(e.message,true);}});
  $('#logout').onclick=()=>guard(async()=>{try{await api('/auth/logout',{});}catch{}token='';tenant='';dirty=false;showLogin();});
  const content=()=>$('#content');
  function record(parent,title,description){const r=node('article',undefined,'record');r.append(node('h3',title),node('p',description));parent.append(r);return r;}
  function actions(r){const a=node('div',undefined,'actions');r.append(a);return a;}
  function choices(items,key,label){return items.map(x=>[x[key],typeof label==='function'?label(x):x[label]]);}
  function select(name,label,options,optional=false){return field(name,label,'select',{options,optional});}
  function command(parent,title,fields,url,base={},method='POST',opts={}){return form(parent,title,fields,'Бүртгэх',v=>api(url,{...base,...v},method),opts);}
  async function roomData(seq){if(overview.completion_only){rooms=overview.rooms;stays=overview.stays;categories=[];return;}const data=await Promise.all([api(path(`rooms?limit=100&after=${enc(roomAfter)}`)),api(path('room-categories')),api(path(`stays/active?limit=100&after=${enc(stayAfter)}`))]);if(seq===generation)[rooms,categories,stays]=data;}
  function pager(parent,kind,items,key){const a=actions(parent);a.append(btn('Эхний хэсэг',()=>guard(()=>{if(kind==='room')roomAfter='';else stayAfter='';navigate(view);})),btn('Дараагийн 100',()=>guard(()=>{if(kind==='room')roomAfter=items.at(-1)[key];else stayAfter=items.at(-1)[key];navigate(view);})));a.lastChild.disabled=items.length<100;parent.append(node('p',`Энэ хэсэгт ${items.length} бүртгэл.`, 'muted'));}
  async function render(next,seq){const parent=content();
    if(['guests','rooms','payments','restaurant','manager','online'].includes(next)){await roomData(seq);if(seq!==generation)return;}
    if(next==='templates'){await templateTools(parent,seq);return;}
    if(next==='inventory'){await inventoryTools(parent,seq);return;}
    if(next==='online'){await onlineTools(parent,seq);return;}
    if(next==='guests'){
      parent.append(node('p','Нэг байрлалтад нэг үндсэн зочин бүртгэнэ. Ирсэн цаг, төлөвлөсөн гарах цаг болон тарифыг сервер баталгаажуулна.'));
      if(role('RECEPTION')&&!overview.completion_only){actions(parent).append(btn('Walk-in зочин бүртгэх',()=>guard(()=>checkin(parent))),btn('POS / банкны барьцаа бэлтгэх',()=>guard(()=>fundingForm(parent))));
        for(const f of overview.funding||[]){const r=record(parent,'Check-in барьцаа',`${labels[f.channel]} · ${money(f.amount_mnt)} · ${labels[f.state]}`);if(f.state==='PENDING'){form(r,'Барьцааны банкны төлөв тулгах',[],'Тулгах',()=>api(path(`check-in-funding/${enc(f.funding_id)}/reconcile`),{}));command(r,'Төлөгдөөгүй барьцааны нэхэмжлэлийг цуцлах',[reason()],path(`check-in-funding/${enc(f.funding_id)}/cancel`));}if(f.state==='CONFIRMED')command(r,'Ашиглаагүй барьцааг буцаах хүсэлт',[reason()],path(`check-in-funding/${enc(f.funding_id)}/return`));if(f.state==='REFUNDING')command(r,'Барьцааны буцаалтыг тулгах',f.channel==='MANUAL_POS'?[field('reference','POS буцаалтын баримтын дугаар'),field('confirmation','Буцаасан баталгаа')]:[],path(`check-in-funding/${enc(f.funding_id)}/return/complete`));}
      }
      if(!stays.length)parent.append(node('p','Одоогоор идэвхтэй байрлалт алга.'));
      for(const s of stays){const room=rooms.find(r=>r.room_id===s.room_id);const r=record(parent,`${room?.number||'Өрөө'} · ${labels[s.kind]}`,`${time(s.actual_checkin_at)} → ${time(s.planned_checkout_at)} · ${money(s.amount_mnt)}${s.overdue?' · Хугацаа хэтэрсэн':''}`);actions(r).append(btn('Байрлалт нээх',()=>guard(()=>openStay(s,r))));}pager(parent,'stay',stays,'stay_id');
      bookings=overview.completion_only?[]:await api(path('bookings'));if(seq!==generation)return;
      parent.append(node('h2','Баталгаажсан онлайн захиалга'));
      for(const b of bookings){const r=record(parent,`${rooms.find(r=>r.room_id===b.room_id)?.number||'Өрөө'} · ${labels[b.state]||b.state}`,`${time(b.planned_checkin_at)} → ${time(b.planned_checkout_at)}`);if(role('RECEPTION')&&b.state==='CONFIRMED')actions(r).append(btn('Захиалгаар check-in хийх',()=>guard(()=>checkin(r,b))));}
    } else if(next==='rooms'){
      for(const r of rooms){const card=record(parent,`${r.number} · ${r.category_name}`,`${labels[r.status]} · ${labels[r.cleaning_state]} · ${r.minibar_mode==='OFF'?'Минибаргүй':r.minibar_mode==='ON'?'Минибартай':'Туршилтын минибартай'}`);const a=actions(card);
        const s=stays.find(s=>s.room_id===r.room_id);if(s)a.append(btn('Байрлалт нээх',()=>guard(()=>openStay(s,card))));
        else if(role('RECEPTION')&&!overview.completion_only&&r.status==='ACTIVE'&&!r.pending_minibar_change)a.append(btn('Зочин бүртгэх',()=>guard(()=>checkin(card,null,r))));
        if(r.pending_minibar_change)card.append(node('p','Минибарын тохиргоо хүлээгдэж буй · Шинэ зочин бүртгэхгүй.'));
        if([25000,30000].includes(packageMnt)&&!overview.completion_only){const panel=node('div');card.append(panel);a.append(btn('Минибарын тохиргоо',()=>guard(()=>roomConfiguration(panel,r.room_id,''))));}
        if(manager()&&!overview.completion_only){a.append(btn('Өрөө удирдах',()=>guard(()=>roomTools(card,r))));}
      }pager(parent,'room',rooms,'room_id');
    } else if(next==='payments'||next==='restaurant'){
      parent.append(node('p',next==='restaurant'?'Рестораны төлбөр буудлын касст орохгүй. Checkout хийхдээ дуусаагүй захиалга бүрийн сонголтыг зочинд мэдээлнэ.':'Байрлалтаа сонгоод нэхэмжлэл, барьцаа, буцаалт болон засварыг бүртгэнэ.'));
      if(!stays.length)parent.append(node('p','Идэвхтэй байрлалт алга.'));
      form(parent,'Байрлалт сонгох',[select('stay_id','Өрөө / байрлалт',choices(stays,'stay_id',s=>`${rooms.find(r=>r.room_id===s.room_id)?.number||'Өрөө'} · ${time(s.actual_checkin_at)}`))],'Нээх',async v=>{const s=stays.find(s=>s.stay_id===v.stay_id);await openStay(s,parent);return {};},{success:async()=>{}});
    } else if(next==='shift')await shiftTools(parent,seq);
    else if(next==='manager')managerTools(parent);
    else if(next==='cleaning')await cleaningTools(parent,seq);
  }
  function inventoryCost(cost){
    if(!cost)return 'Өртөг тогтоогдоогүй';
    const n=BigInt(cost.numerator),d=BigInt(cost.denominator);
    return n%d===0n?money(n/d):`${money(Number(n)/Number(d))} (ойролцоо)`;
  }
  async function inventoryTools(parent,seq){
    if(!manager()||![25000,30000].includes(packageMnt)||overview.completion_only){parent.append(node('p','Агуулахын мэдээлэл харах эрх алга.'));return;}
    const data=await api(path(`minibar/products?limit=50&after=${enc(inventoryAfter)}`));if(seq!==generation)return;
    parent.append(node('p','Бүтээгдэхүүний тоо нь агуулахын үлдэгдэл. Худалдах үнэ болон худалдан авалтын өртгийг тусад нь бүртгэнэ.'));
    const editor=node('div');parent.append(editor);
    actions(parent).append(btn('Бүтээгдэхүүн бүртгэх',()=>guard(()=>{
      editor.replaceChildren();const f=form(editor,'Шинэ бүтээгдэхүүн',[
        field('name','Бүтээгдэхүүний нэр','text',{max:200}),field('category','Бүтээгдэхүүний ангилал','text',{max:200}),field('unit','Хэмжих нэгж','text',{value:'ширхэг',max:50}),
        amount('selling_price_mnt','Худалдах нэгж үнэ (₮)'),field('unit_cost_mnt','Худалдан авалтын нэгж өртөг (₮)','number',{min:0}),
        field('opening_quantity','Агуулахын анхны тоо','number',{min:0}),select('status','Эхлэх төлөв',[['ACTIVE','Идэвхтэй'],['INACTIVE','Идэвхгүй']])
      ],'Бүтээгдэхүүн бүртгэх',v=>api(path('minibar/products'),v),{success:async()=>{inventoryAfter='';await navigate('inventory');say('Бүтээгдэхүүн болон агуулахын анхны үлдэгдэл бүртгэгдлээ.');}});f.querySelector('input').focus();
    })));
    if(!data.items.length)parent.append(node('p',inventoryAfter?'Энэ хэсэгт бүтээгдэхүүн алга. Эхний хэсэг рүү буцаж болно.':'Бүтээгдэхүүн бүртгэлгүй байна. Эхний бүтээгдэхүүнээ бүртгэнэ үү.'));
    for(const p of data.items){
      const r=record(parent,p.name,`${p.category} · ${labels[p.status]} · Агуулахад ${p.warehouse_quantity} ${p.unit}`);
      r.append(node('p',`Худалдах үнэ: ${money(p.selling_price_mnt)} · Дундаж өртөг: ${inventoryCost(p.average_cost)}`));
      const a=actions(r),panel=node('div');r.append(panel);
      if(p.status==='ACTIVE')a.append(btn('Орлого бүртгэх',()=>guard(()=>{
        panel.replaceChildren();const f=form(panel,`${p.name} — агуулахын орлого`,[field('quantity','Хүлээн авсан тоо','number',{min:1}),field('unit_cost_mnt','Худалдан авалтын нэгж өртөг (₮)','number',{min:0}),field('reference','Баримтын дугаар / тайлбар','text',{optional:true,max:200})],
          'Орлого баталгаажуулах',v=>api(path(`minibar/products/${enc(p.product_id)}/receipts`),{...v,expected_revision:p.stock_revision}),{success:async()=>{await navigate('inventory');say('Агуулахын орлого бүртгэгдлээ.');}});f.querySelector('input').focus();
      })));
      a.append(btn('Хөдөлгөөний түүх',()=>guard(()=>inventoryLedger(panel,p,0))));
    }
    const pages=actions(parent);pages.append(btn('Эхний хэсэг',()=>guard(()=>{inventoryAfter='';navigate('inventory');})),btn('Дараагийн хэсэг',()=>guard(()=>{inventoryAfter=data.next_after;navigate('inventory');})));
    pages.firstChild.disabled=!inventoryAfter;pages.lastChild.disabled=!data.next_after;parent.append(node('p',`Энэ хэсэгт ${data.items.length} бүтээгдэхүүн.`, 'muted'));
  }
  async function inventoryLedger(container,product,after){
    const parent=node('div');container.replaceChildren(parent);
    const seq=generation;parent.replaceChildren(node('p','Хөдөлгөөний түүх ачаалж байна…'));parent.setAttribute('aria-busy','true');
    try{const data=await api(path(`minibar/products/${enc(product.product_id)}/ledger?limit=50&after=${after}`));if(seq!==generation||!parent.isConnected)return;
      parent.replaceChildren();table(parent,`${product.name} — агуулахын түүх`,['Цаг (Улаанбаатар)','Хөдөлгөөн','Тоо','Нэгж өртөг','Үлдэгдэл','Баримт','Бүртгэсэн ажилтан'],data.items.map(r=>[time(r.recorded_at),r.kind==='OPENING'?'Анхны үлдэгдэл':'Худалдан авалт',r.quantity,money(r.unit_cost_mnt),r.warehouse_quantity,r.reference||'—',r.actor_label]));
      const a=actions(parent);a.append(btn('Түүхийн эхний хэсэг',()=>inventoryLedger(container,product,0)),btn('Түүхийн дараагийн хэсэг',()=>inventoryLedger(container,product,data.next_after)));a.firstChild.disabled=after===0;a.lastChild.disabled=data.next_after===null;
    }catch(e){if(seq===generation&&parent.isConnected)parent.replaceChildren(node('p',e.message,'error'),btn('Түүхийг дахин ачаалах',()=>inventoryLedger(container,product,after)));}finally{parent.setAttribute('aria-busy','false');}
  }
  const templatePath=(t,v='')=>path(`minibar/templates/${enc(t)}/versions${v?'/'+enc(v):''}`);
  function chooseTemplate(selection){templateSelection=selection;navigate('templates');}
  async function templateTools(parent,seq){
    if(!manager()||![25000,30000].includes(packageMnt)||overview.completion_only){parent.append(node('p','Минибарын загвар удирдах эрх алга.'));return;}
    if(templateSelection?.version){await templateDetail(parent,seq);return;}
    if(templateSelection){await templateVersions(parent,seq);return;}
    const data=await api(path(`minibar/templates?limit=50&after=${enc(templateAfter)}`));if(seq!==generation)return;
    parent.append(node('p','Өрөөний минибарт байлгах бүтээгдэхүүн, тоог загварын хувилбараар бэлтгэнэ.'));
    const editor=node('div');parent.append(editor);
    actions(parent).append(btn('Загвар үүсгэх',()=>guard(()=>{editor.replaceChildren();const f=form(editor,'Шинэ минибарын загвар',[field('name','Загварын нэр','text',{max:200})],'Загвар үүсгэх',v=>api(path('minibar/templates'),v),{success:async()=>{templateAfter='';await navigate('templates');say('Загвар үүсгэлээ. Бүрдлийн ноорог хувилбараа нэмнэ үү.');}});f.querySelector('input').focus();})));
    if(!data.items.length)parent.append(node('p','Минибарын загвар бүртгэлгүй байна.'));
    for(const t of data.items){const r=record(parent,t.name,`${labels[t.status]} · ${t.default_version_id?'Нийтэлсэн үндсэн хувилбартай':'Нийтэлсэн хувилбаргүй'}`);actions(r).append(btn('Хувилбаруудыг нээх',()=>guard(()=>chooseTemplate({id:t.template_id,after:0}))));}
    const pages=actions(parent);pages.append(btn('Загварын эхний хэсэг',()=>guard(()=>{templateAfter='';navigate('templates');})),btn('Загварын дараагийн хэсэг',()=>guard(()=>{templateAfter=data.next_after;navigate('templates');})));pages.firstChild.disabled=!templateAfter;pages.lastChild.disabled=!data.next_after;
    parent.append(node('p',`Энэ хэсэгт ${data.items.length} загвар.`, 'muted'));
  }
  async function templateVersions(parent,seq){
    const selected={...templateSelection},data=await api(templatePath(selected.id)+`?limit=50&after=${selected.after||0}`);if(seq!==generation)return;
    actions(parent).append(btn('Загварын жагсаалт',()=>guard(()=>chooseTemplate(null))));parent.append(node('h2',data.name));
    if(data.status==='ACTIVE')form(parent,'Хоосон ноорог хувилбар',[],'Ноорог үүсгэх',v=>api(templatePath(selected.id),{...v,expected_revision:data.revision}),{success:async r=>{templateSelection={id:selected.id,version:r.version.version_id};await navigate('templates');say('Ноорог хувилбар үүслээ. Бүтээгдэхүүнээ нэмнэ үү.');}});
    if(!data.items.length)parent.append(node('p','Хувилбар үүсээгүй байна.'));
    for(const v of data.items){const r=record(parent,`Хувилбар ${v.version_number}`,`${v.state==='DRAFT'?'Ноорог':'Нийтэлсэн'}${data.default_version_id===v.version_id?' · Үндсэн хувилбар':''}`);actions(r).append(btn('Бүрдлийг нээх',()=>guard(()=>chooseTemplate({id:selected.id,version:v.version_id}))));}
    const pages=actions(parent);pages.append(btn('Хувилбарын эхний хэсэг',()=>guard(()=>chooseTemplate({id:selected.id,after:0}))),btn('Хувилбарын дараагийн хэсэг',()=>guard(()=>chooseTemplate({id:selected.id,after:data.next_after}))));pages.firstChild.disabled=!(selected.after);pages.lastChild.disabled=!data.next_after;
  }
  async function templateDetail(parent,seq){
    const selected={...templateSelection},url=templatePath(selected.id,selected.version),data=await api(url);if(seq!==generation)return;
    const v=data.version,items=v.items.map(i=>({product_id:i.product_id,target_quantity:i.target_quantity}));
    actions(parent).append(btn('Хувилбарын жагсаалт',()=>guard(()=>chooseTemplate({id:selected.id,after:0}))));
    parent.append(node('h2',`${data.name} · Хувилбар ${v.version_number}`),node('p',`${v.state==='DRAFT'?'Ноорог':'Нийтэлсэн'}${data.default_version_id===v.version_id?' · Үндсэн хувилбар':''}`));
    table(parent,'Минибарын бүрдэл',['Бүтээгдэхүүн','Тоо','Нэгж'],v.items.map(i=>[`${i.name}${i.product_status&&i.product_status!=='ACTIVE'?' · Идэвхгүй':''}`,i.target_quantity,i.unit]));
    if(!items.length)parent.append(node('p','Бүрдэл хоосон байна. Бүтээгдэхүүн нэмнэ үү.'));
    if(data.status!=='ACTIVE')return;
    const refresh=message=>async()=>{await navigate('templates');say(message);};
    const panel=node('div');parent.append(panel);
    if(v.state==='DRAFT'){
      actions(parent).append(btn('Бүтээгдэхүүн нэмэх',()=>guard(()=>templateProductPicker(panel,data,0))),btn('Тоо өөрчлөх / хасах',()=>guard(()=>{
        panel.replaceChildren();if(!items.length){panel.append(node('p','Өөрчлөх бүтээгдэхүүн алга.'));return;}
        const f=form(panel,'Ноорог бүрдлийн тоо өөрчлөх',[select('product_id','Бүрдлийн бүтээгдэхүүн',choices(v.items,'product_id',i=>`${i.name} · ${i.target_quantity} ${i.unit}`)),field('target_quantity','Шинэ тоо (0 бол бүрдлээс хасна)','number',{min:0})],'Бүрдлийг хадгалах',value=>api(url,{items:items.filter(i=>i.product_id!==value.product_id).concat(value.target_quantity?[{product_id:value.product_id,target_quantity:value.target_quantity}]:[]),expected_revision:data.revision,idempotency_key:value.idempotency_key},'PUT'),{success:refresh('Ноорог бүрдэл хадгалагдлаа.')});f.querySelector('select').focus();
      })));
      parent.append(node('p','Нийтэлсний дараа энэ хувилбарын бүрдлийг засахгүй. Өөрчлөх бол шинэ ноорог хувилбар үүсгэнэ.'));
      form(parent,'Бүрдлийг нийтлэх',[field('reviewed','Бүтээгдэхүүн болон тоог шалгасан','checkbox')],'Хувилбарыг нийтлэх',value=>api(url+'/publish',{expected_revision:data.revision,idempotency_key:value.idempotency_key}),{success:refresh('Хувилбар нийтлэгдлээ.')});
    }else if(data.default_version_id!==v.version_id){
      parent.append(node('p','Үндсэн хувилбар нь шинэ өрөөний тохиргоонд эхэлж санал болгох бүрдэл болно. Одоо ашиглаж буй өрөөнүүдийн бүрдэл хэвээр байна.'));
      form(parent,'Үндсэн хувилбар сонгох',[],'Үндсэн хувилбар болгох',value=>api(url+'/default',{expected_revision:data.revision,idempotency_key:value.idempotency_key}),{success:refresh('Үндсэн хувилбар солигдлоо.')});
    }
    if(v.state==='PUBLISHED')actions(parent).append(btn('Өрөөнд тохируулах хүсэлт',()=>guard(()=>configurationRoomPicker(panel,data,''))));
    form(parent,'Энэ бүрдлээс шинэ хувилбар бэлтгэх',[],'Ноорог хуулбар үүсгэх',value=>api(templatePath(selected.id),{source_version_id:v.version_id,expected_revision:data.revision,idempotency_key:value.idempotency_key}),{success:async r=>{templateSelection={id:selected.id,version:r.version.version_id};await navigate('templates');say('Бүрдлээс шинэ ноорог хувилбар үүслээ.');}});
  }
  const configurationNotice='Хүсэлт илгээмэгц энэ өрөөнд шинэ зочин болон захиалга оноохыг түр хаана. Одоогийн зочин, минибарын горим хэвээр үлдэнэ. Тооллого, барааны шилжүүлэлт дууссаны дараа тохиргоог хэрэгжүүлнэ.';
  async function configurationRoomPicker(container,data,after){
    const parent=node('div'),seq=generation;container.replaceChildren(parent);parent.append(node('p','Өрөөнүүд ачаалж байна…'));parent.setAttribute('aria-busy','true');
    try{
      const list=await api(path(`rooms?limit=100&after=${enc(after)}`));if(seq!==generation||!parent.isConnected)return;
      parent.replaceChildren();parent.append(node('p',configurationNotice));
      const available=list.filter(r=>r.status==='ACTIVE'&&r.category_status==='ACTIVE'&&!r.pending_minibar_change);
      if(available.length){const f=form(parent,`${data.name} · Хувилбар ${data.version.version_number} тохируулах`,[select('room_id','Тохируулах өрөө',choices(available,'room_id',r=>`${r.number} · ${r.category_name}`)),reason(),field('reviewed','Өрөөний шинэ бүртгэл түр хаагдахыг ойлгосон','checkbox')],'Тохиргооны хүсэлт илгээх',v=>api(path(`rooms/${enc(v.room_id)}/minibar-configuration/requests`),{target_mode:'ON',target_template_id:data.template_id,target_version_id:data.version.version_id,expected_room_revision:available.find(r=>r.room_id===v.room_id).revision,reason:v.reason,idempotency_key:v.idempotency_key}),{success:async()=>{await navigate('rooms');say('Тохиргооны хүсэлт бүртгэгдлээ. Өрөөний шинэ бүртгэл түр хаагдсан.');}});f.querySelector('select').focus();}
      else parent.append(node('p','Энэ хэсэгт хүсэлт илгээж болох өрөө алга. Дараагийн хэсгийг шалгана уу.'));
      const pages=actions(parent);pages.append(btn('Өрөөний эхний хэсэг',()=>guard(()=>configurationRoomPicker(container,data,''))),btn('Өрөөний дараагийн хэсэг',()=>guard(()=>configurationRoomPicker(container,data,list.at(-1).room_id))));pages.firstChild.disabled=!after;pages.lastChild.disabled=list.length<100;
    }catch(e){if(seq===generation&&parent.isConnected)parent.replaceChildren(node('p',e.message,'error'),btn('Өрөөнүүдийг дахин ачаалах',()=>configurationRoomPicker(container,data,after)));}finally{parent.setAttribute('aria-busy','false');}
  }
  async function roomConfiguration(container,room,after){
    const parent=node('div'),seq=generation;container.replaceChildren(parent);parent.append(node('p','Тохиргоо ачаалж байна…'));parent.setAttribute('aria-busy','true');
    try{
      const data=await api(path(`rooms/${enc(room)}/minibar-configuration?limit=20&after=${enc(after)}`));if(seq!==generation||!parent.isConnected)return;
      parent.replaceChildren();parent.append(node('h2',`${data.room_number} · Минибарын тохиргоо`),node('p',`Одоогийн горим: ${data.current.mode==='OFF'?'Минибаргүй':data.current.mode==='ON'?'Минибартай':'Туршилтын минибартай'}`));
      const p=data.pending;
      if(p){parent.append(node('h3','Хүлээгдэж буй хүсэлт'),node('p',labels[p.state]),node('p',p.target_mode==='OFF'?'Зорилго: минибарыг унтраах':`Зорилго: ${p.target_snapshot.template_name} · Хувилбар ${p.target_snapshot.version_number}`),node('p',`Шалтгаан: ${p.reason}`),node('p',configurationNotice));
        table(parent,'Хүсэлтийн бүрдэл',['Бүтээгдэхүүн','Тоо','Нэгж'],p.target_snapshot.items.map(i=>[i.name,i.target_quantity,i.unit]));
        if(manager()&&['SCHEDULED_AFTER_STAY','READY_FOR_RECONCILIATION'].includes(p.state))form(parent,'Тохиргооны тооллого даалгах',[select('assignee_id','Тоолох цэвэрлэгч',choices((overview.staff||[]).filter(s=>s.roles.includes('CLEANER')),'account_id','email'))],'Тооллого даалгах',v=>api(path(`minibar/configuration-requests/${enc(p.request_id)}/prepare`),{...v,expected_revision:p.revision}),{success:async()=>{await navigate('rooms');say('Тооллогын ажил даалгалаа. Цэвэрлэгч өөрийн ажлаас нээнэ.');}});
        if(manager()&&!['SCHEDULED_AFTER_STAY','READY_FOR_RECONCILIATION'].includes(p.state)){const detail=node('div');parent.append(detail);actions(parent).append(btn('Тооллого, шилжүүлэлтийн төлөвлөгөө',()=>guard(async()=>{detail.replaceChildren(node('p','Төлөвлөгөө ачаалж байна…'));try{const data=await api(path(`minibar/configuration-requests/${enc(p.request_id)}/reconciliation`));if(seq!==generation||!detail.isConnected)return;detail.replaceChildren();reconciliationPlan(detail,data.plan);}catch(e){if(seq===generation&&detail.isConnected)detail.replaceChildren(node('p',e.message+' Төлөвлөгөөний товчоор дахин оролдоно уу.','error'));}})));}
        if(manager())form(parent,'Хүлээгдэж буй хүсэлтийг цуцлах',[reason()],'Хүсэлтийг цуцлах',v=>api(path(`minibar/configuration-requests/${enc(p.request_id)}/cancel`),{...v,expected_revision:p.revision}),{success:async()=>{await navigate('rooms');say('Хүсэлт цуцлагдлаа. Өрөөний бусад бэлэн байдлын шалгалт хэвээр үйлчилнэ.');}});
      }else{parent.append(node('p','Хүлээгдэж буй тохиргооны хүсэлт алга.'));
        if(manager()&&data.current.mode!=='OFF')form(parent,'Минибарыг унтраах хүсэлт',[reason(),field('reviewed','Өрөөний шинэ бүртгэл түр хаагдахыг ойлгосон','checkbox')],'Унтраах хүсэлт илгээх',v=>api(path(`rooms/${enc(room)}/minibar-configuration/requests`),{target_mode:'OFF',expected_room_revision:data.current.room_revision,reason:v.reason,idempotency_key:v.idempotency_key}),{success:async()=>{await navigate('rooms');say('Унтраах хүсэлт бүртгэгдлээ. Барааны тооллого, буцаалт шаардлагатай.');}});
      }
      table(parent,'Хүсэлтийн жагсаалт',['Бүртгэсэн цаг','Зорилго','Төлөв','Шалтгаан'],data.items.map(i=>[time(i.recorded_at),i.target_mode==='OFF'?'Унтраах':`${i.target_snapshot.template_name} · ${i.target_snapshot.version_number}`,labels[i.state],i.cancel_reason||i.reason]));
      const pages=actions(parent);pages.append(btn('Хүсэлтийн эхний хэсэг',()=>guard(()=>roomConfiguration(container,room,''))),btn('Хүсэлтийн дараагийн хэсэг',()=>guard(()=>roomConfiguration(container,room,data.next_after))));pages.firstChild.disabled=!after;pages.lastChild.disabled=!data.next_after;
    }catch(e){if(seq===generation&&parent.isConnected)parent.replaceChildren(node('p',e.message,'error'),btn('Тохиргоог дахин ачаалах',()=>roomConfiguration(container,room,after)));}finally{parent.setAttribute('aria-busy','false');}
  }
  async function templateProductPicker(container,data,after){
    const parent=node('div'),seq=generation;container.replaceChildren(parent);parent.append(node('p','Бүтээгдэхүүн ачаалж байна…'));parent.setAttribute('aria-busy','true');
    try{
      const products=await api(path(`minibar/products?limit=50&after=${enc(after||'')}`));if(seq!==generation||!parent.isConnected)return;
      parent.replaceChildren();const available=products.items.filter(p=>p.status==='ACTIVE'&&!data.version.items.some(i=>i.product_id===p.product_id));
      if(available.length){const f=form(parent,'Ноорог бүрдэлд бүтээгдэхүүн нэмэх',[select('product_id','Нэмэх бүтээгдэхүүн',choices(available,'product_id',p=>`${p.name} · ${p.unit}`)),field('target_quantity','Байлгах тоо','number',{min:1})],'Бүрдэлд нэмэх',v=>api(templatePath(data.template_id,data.version.version_id),{expected_revision:data.revision,idempotency_key:v.idempotency_key,items:data.version.items.map(i=>({product_id:i.product_id,target_quantity:i.target_quantity})).concat([{product_id:v.product_id,target_quantity:v.target_quantity}])},'PUT'),{success:async()=>{await navigate('templates');say('Ноорог бүрдэлд бүтээгдэхүүн нэмэгдлээ.');}});f.querySelector('select').focus();}
      else parent.append(node('p','Энэ хэсэгт нэмж болох бүтээгдэхүүн алга. Агуулахад идэвхтэй бүтээгдэхүүн бүртгэх эсвэл дараагийн хэсгийг шалгана уу.'));
      const pages=actions(parent);pages.append(btn('Бүтээгдэхүүний эхний хэсэг',()=>guard(()=>templateProductPicker(container,data,''))),btn('Бүтээгдэхүүний дараагийн хэсэг',()=>guard(()=>templateProductPicker(container,data,products.next_after))));pages.firstChild.disabled=!after;pages.lastChild.disabled=!products.next_after;
    }catch(e){if(seq===generation&&parent.isConnected)parent.replaceChildren(node('p',e.message,'error'),btn('Бүтээгдэхүүнийг дахин ачаалах',()=>templateProductPicker(container,data,after)));}finally{parent.setAttribute('aria-busy','false');}
  }
  function fundingForm(parent){form(parent,'Check-in барьцаа бэлтгэх',[select('room_id','Өрөө',choices(rooms,'room_id','number')),select('channel','Суваг',channels().filter(c=>c[0]!=='CASH')),field('reference','POS баримтын дугаар','text',{optional:true}),field('terminal_id','Терминалын дугаар','text',{optional:true}),field('transacted_at','POS гүйлгээний цаг (Улаанбаатар)','datetime-local',{optional:true})],'Барьцааны эх үүсвэр бүртгэх',v=>{const body={room_id:v.room_id,channel:v.channel,idempotency_key:v.idempotency_key};if(v.channel==='MANUAL_POS')Object.assign(body,{reference:v.reference||'',terminal_id:v.terminal_id||'',transacted_at:v.transacted_at?new Date(v.transacted_at+'+08:00').toISOString():''});return api(path('check-in-funding'),body);});}
  function checkin(parent,booking=null,room=null){
    const kinds=[['MN_REG_NO','Монгол регистр'],['FOREIGN_PASSPORT','Гадаад паспорт'],['OTHER_GOV_ID','Бусад төрийн баримт'],['NO_DOCUMENT','Баримтгүй']];
    const start=node('div');parent.append(start);
    form(start,'Бүртгэлийн төрөл',[select('identity_type','Баримтын төрөл',kinds)],'Зочны мэдээлэл оруулах',async v=>v,{success:async(r,f)=>{f.remove();const fields=[field('family_name','Овог'),field('given_name','Нэр'),field('date_of_birth','Төрсөн огноо','date'),field('nationality','Иргэншил')];
      if(r.identity_type!=='NO_DOCUMENT')fields.push(field('document_number','Баримтын дугаар'));
      if(['FOREIGN_PASSPORT','OTHER_GOV_ID'].includes(r.identity_type))fields.push(field('issuing_country','Олгосон улс (2 үсэг)'));
      if(r.identity_type==='FOREIGN_PASSPORT')fields.push(field('expiry_date','Баримтын дуусах огноо','date'));
      if(r.identity_type==='OTHER_GOV_ID')fields.push(field('document_type','Баримтын төрөл'),field('issuing_authority','Олгосон байгууллага'));
      if(r.identity_type==='NO_DOCUMENT')fields.push(field('no_document_reason','Баримтгүй шалтгаан','textarea'),field('note','Нэмэлт тайлбар','textarea'));
      fields.push(field('guardian_name','Асран хамгаалагчийн нэр','text',{optional:true}),field('guardian_phone','Асран хамгаалагчийн утас','tel',{optional:true}),field('guardian_relationship','Хамаарал','text',{optional:true}));
      if(!booking)fields.push(select('room_id','Өрөө',choices(room?[room]:rooms.filter(r=>r.status==='ACTIVE'&&!r.pending_minibar_change),'room_id','number')),select('kind','Хугацааны төрөл',[['HOURLY','Цагаар'],['NIGHTLY','Хоногоор']]),amount('duration_units','Цаг / хоногийн тоо',1),select('deposit_channel','Барьцаа авах суваг',[["CASH","Бэлэн"],["FUNDING","Баталгаажсан POS / банкны барьцаа"]]),amount('deposit_amount','Бэлнээр авсан барьцаа (₮)'),field('received','Бэлэн барьцааг биечлэн авсан','checkbox',{optional:true}),select('funding_id','Өмнө баталгаажсан барьцаа',[['','Сонгоогүй'],...choices(overview.funding?.filter(f=>f.state==='CONFIRMED')||[],'funding_id',f=>`${rooms.find(r=>r.room_id===f.room_id)?.number||'Өрөө'} · ${labels[f.channel]} · ${money(f.amount_mnt)}`)],true));
      const depositField=fields.find(f=>f.name==='deposit_amount');if(depositField)depositField.optional=true;
      if(booking?.category_id)fields.push(select('room_id','Оноох өрөө',choices(rooms.filter(r=>r.status==='ACTIVE'&&!r.pending_minibar_change),'room_id',r=>`${r.number} · ${r.category_name}`)));
      fields.push(field('actual_checkin_at','Өмнө ирсэн цаг (Улаанбаатар)','datetime-local',{optional:true}),field('backdate_reason','Өмнө ирсэн цагийн шалтгаан','textarea',{optional:true}));
      form(start,booking?'Онлайн захиалгаар зочин бүртгэх':'Walk-in зочин бүртгэх',fields,'Check-in баталгаажуулах',async v=>{
        const guest={identity_type:r.identity_type};for(const key of ['family_name','given_name','date_of_birth','nationality','document_number','issuing_country','expiry_date','document_type','issuing_authority','no_document_reason','note'])if(v[key])guest[key]=v[key];
        if(v.guardian_name||v.guardian_phone||v.guardian_relationship)guest.guardian={name:v.guardian_name||'',phone:v.guardian_phone||'',relationship:v.guardian_relationship||''};
        const body={guest,idempotency_key:v.idempotency_key};if(v.actual_checkin_at)body.actual_checkin_at=new Date(v.actual_checkin_at+'+08:00').toISOString();if(v.backdate_reason)body.backdate_reason=v.backdate_reason;
        if(!booking){Object.assign(body,{room_id:v.room_id,kind:v.kind,duration_units:v.duration_units});if(v.deposit_channel==='CASH')body.deposit={channel:'CASH',amount_mnt:v.deposit_amount||0,received:v.received};else body.funding_id=v.funding_id||'';}
        if(booking?.category_id)body.room_id=v.room_id;
        return api(booking?path(`${booking.category_id?'booking-holds':'bookings'}/${enc(booking.booking_id)}/check-in`):path('stays/check-in'),body);
      },{success:async(result,f,status)=>{showResult(status,result);f.querySelector('button[type=submit]').hidden=true;await reloadOverview();status.append(btn('Байрлалтыг нээх',()=>openStay({stay_id:result.stay_id,room_id:result.room_id},start)));}});
    }});
  }
  async function openStay(s,parent){if(!s)return;const seq=generation;const panel=node('div');parent.append(panel);panel.append(node('p','Байрлалт ачаалж байна…'));
    try{const [finance,preview,guest]=await Promise.all([api(stayPath(s.stay_id,'finance')),api(stayPath(s.stay_id,'checkout/preview')),api(stayPath(s.stay_id,'guest'))]);if(seq!==generation)return;
      panel.replaceChildren();selected=s;panel.append(node('h2',`${guest.room_number} · ${guest.guest.family_name} ${guest.guest.given_name}`));
      panel.append(node('p',`Төлөөгүй: ${money(finance.charge_unpaid_mnt)} · Барьцааны боломжит үлдэгдэл: ${money(finance.balance.available)} · Буцаалтад нөөцөлсөн: ${money(finance.balance.refund_reserved)}`));
      if(finance.balance.frozen)panel.append(node('p','Санхүүгийн тулгалт хүлээгдэж байна. Platform-ийн хяналт шаардлагатай.','notice'));
      const rev={expected_revision:finance.balance.revision},prefix=suffix=>stayPath(s.stay_id,suffix);
      const a=actions(panel);a.append(btn('Байрлалт шинэчлэх',()=>guard(()=>{panel.remove();openStay(s,parent);})));if(role('RECEPTION')){
        if(packageMnt===30000)a.append(btn('Нэг удаагийн код өгөх',()=>guard(()=>command(panel,'Зочны нэвтрэх код',[],prefix('guest-codes')))));
        a.append(btn('Төхөөрөмж удирдах',()=>guard(async()=>{try{const devices=await api(prefix('guest-sessions'));for(const d of devices){const r=record(panel,'Зочны төхөөрөмж',time(d.created_at));command(r,'Энэ төхөөрөмжийн эрхийг цуцлах',[],prefix(`guest-sessions/${enc(d.session_id)}/revoke`));}if(!devices.length)panel.append(node('p','Идэвхтэй төхөөрөмж алга.'));}catch(e){say(e.message,true);}})));
        a.append(btn('Ирсэн цагийн засвар хүсэх',()=>guard(()=>form(panel,'Ирсэн цагийн засвар',[field('actual_checkin_at','Зөв ирсэн цаг (Улаанбаатар)','datetime-local'),reason()],'Хүсэлт илгээх',v=>api(prefix('time-amendments'),{...v,actual_checkin_at:new Date(v.actual_checkin_at+'+08:00').toISOString()})))));
        a.append(btn('Checkout эхлүүлэх',()=>guard(()=>command(panel,'Checkout эхлүүлэх',[],prefix('checkout/initiate')))));
      }
      if(manager()||role('RECEPTION'))a.append(btn('Ирсэн цагийн хүсэлтүүд',()=>guard(async()=>{try{const amendments=await api(prefix('time-amendments'));for(const m of amendments){const r=record(panel,labels[m.state],time(m.actual_checkin_at));if(role('MANAGER')&&m.state==='PENDING')form(r,'Шийдвэр',[select('approve','Шийдвэр',[['yes','Зөвшөөрөх'],['no','Татгалзах']]),reason()],'Шийдвэр бүртгэх',v=>api(prefix(`time-amendments/${enc(m.amendment_id||m.id)}/decision`),{...v,approve:v.approve==='yes'}));}if(!amendments.length)panel.append(node('p','Цагийн засварын хүсэлт алга.'));}catch(e){say(e.message,true);}})));
      for(const charge of finance.charges){const r=record(panel,labels[charge.kind],`${money(charge.amount_mnt)} · Төлсөн ${money(charge.paid_mnt)}`);
        if(role('RECEPTION')&&charge.amount_mnt>charge.paid_mnt){const acts=actions(r);
          acts.append(btn('Төлбөр авах',()=>guard(()=>paymentForm(r,s,charge,rev))));
          if(finance.balance.available>0)acts.append(btn('Барьцаанаас суутгах',()=>guard(()=>command(r,'Барьцаанаас суутгах',[select('receipt_id','Барьцааны эх үүсвэр',choices(finance.receipts.filter(r=>r.purpose==='DEPOSIT'&&r.amount_mnt-r.allocated-r.refund_reserved-r.refunded-r.reversed>0),'id',r=>`${labels[r.channel]} · ${money(r.amount_mnt-r.allocated-r.refund_reserved-r.refunded-r.reversed)}`)),amount()],prefix('deposit-allocations'),{...rev,charge_id:charge.id}))));}
      }
      for(const receipt of finance.receipts){const r=record(panel,`${labels[receipt.purpose]} · ${labels[receipt.channel]}`,`${money(receipt.amount_mnt)} · Суутгасан ${money(receipt.allocated)} · Буцаасан ${money(receipt.refunded)} · Reversal ${money(receipt.reversed)}`);
        if(role('RECEPTION')){const acts=actions(r);if(receipt.purpose==='DEPOSIT'&&receipt.amount_mnt-receipt.allocated-receipt.refund_reserved-receipt.refunded-receipt.reversed>0)acts.append(btn('Буцаалт нөөцлөх',()=>guard(()=>command(r,'Барьцааны буцаалт',[amount(),select('channel','Буцаах суваг',channels()),field('recipient','Хүлээн авагч / данс'),reason()],prefix('refunds'),{...rev,receipt_id:receipt.id}))));
          if(!receipt.reversed&&!receipt.refunded&&!receipt.refund_reserved)acts.append(btn('Бүртгэл залруулах',()=>guard(()=>correctionForm(r,s,receipt,rev))));}
      }
      for(const p of finance.payment_intents){const r=record(panel,`${labels[p.provider]} · ${money(p.amount_mnt)}`,labels[p.state]||p.state);if(p.state==='PENDING'&&role('RECEPTION')){form(r,'Банкны төлөв тулгах',[],'Тулгах',()=>api(prefix(`payment-intents/${enc(p.id)}/reconcile`),{}));command(r,'Төлөгдөөгүй нэхэмжлэлийг цуцлах',[reason()],prefix(`payment-intents/${enc(p.id)}/cancel`),rev);}}
      for(const refund of finance.refunds){const r=record(panel,'Буцаалт',`${money(refund.amount_mnt)} · ${labels[refund.state]}`);if(refund.state==='RESERVED'){
        if(role('RECEPTION')){command(r,'Биечлэн дууссан буцаалтыг батлах',[field('recipient_confirmation','Хүлээн авсан баталгаа'),field('reference','POS буцаалтын дугаар','text',{optional:true})],prefix(`refunds/${enc(refund.id)}/complete`),rev);form(r,'Банкны буцаалт тулгах',[],'Тулгах',()=>api(prefix(`refunds/${enc(refund.id)}/reconcile`),{}));}
        if(manager()){form(r,'Өөр сувгийн буцаалтын шийдвэр',[select('approve','Шийдвэр',[['yes','Зөвшөөрөх'],['no','Татгалзах']]),reason()],'Шийдвэр бүртгэх',v=>api(prefix(`refunds/${enc(refund.id)}/approval`),{...v,approve:v.approve==='yes'}));command(r,'Илгээгээгүй / амжилтгүйг баталсан буцаалтыг чөлөөлөх',[reason(),field('cash_not_handed','Зочинд мөнгө очоогүйг баталж байна','checkbox')],prefix(`refunds/${enc(refund.id)}/release`),rev);}
      }}
      for(const correction of finance.corrections){const r=record(panel,'Төлбөрийн засвар',`${labels[correction.state]} · Шинэ дүн ${money(correction.replacement_amount_mnt)}`);if(correction.state==='PENDING'){
        if(role('RECEPTION'))form(r,'Засварын банкны нэхэмжлэл',[],'Нэхэмжлэл үүсгэх',()=>api(prefix(`financial-corrections/${enc(correction.id)}/invoice`),{}));
        if(manager())form(r,'Засварын шийдвэр',[select('approve','Шийдвэр',[['yes','Зөвшөөрөх'],['no','Татгалзах']]),reason()],'Шийдвэр бүртгэх',v=>api(prefix(`financial-corrections/${enc(correction.id)}/decision`),{...rev,...v,approve:v.approve==='yes'}));}}
      if(preview.inspection){panel.append(node('h3',`Минибар · ${labels[preview.inspection.state]}`));if(preview.report)for(const item of preview.report.items)panel.append(node('p',`${item.name} · ${item.used_quantity} хэрэглэсэн`));
        if(role('RECEPTION')||manager())form(panel,'Минибарын тайлан хянах',[select('action','Үйлдэл',role('RECEPTION')?[['RETURN','Дахин шалгуулах'],['DISPUTE','Маргаан үүсгэх']]:[['UPHOLD','Тайланг хэвээр батлах'],['WAIVE','Төлбөрөөс чөлөөлөх']]),reason()],'Шийдвэр бүртгэх',v=>api(prefix('minibar-review'),v));}
      const checkoutFields=[];for(const order of preview.restaurant_orders){panel.append(node('p',`${order.restaurant_name} · ${order.contact_phone} · ${labels[order.state]||order.state}`));checkoutFields.push(select('order_'+order.order_id,`${order.restaurant_name} — зочны сонголт`,[['RECEPTION_PICKUP','Reception дээр хүлээн авах'],['GUEST_PICKUP','Зочин өөрөө авах'],['REFUND_REQUEST','Буцаалт хүсэх'] ]));}
      if(preview.restaurant_orders.length)checkoutFields.push(field('guest_informed','Дуусаагүй захиалга бүрийг зочинд мэдээлсэн','checkbox'));
      if(role('RECEPTION'))form(panel,'Checkout дуусгах',checkoutFields,'Зочны checkout баталгаажуулах',v=>api(prefix('checkout'),{...rev,idempotency_key:v.idempotency_key,restaurant_choices:preview.restaurant_orders.map(o=>({order_id:o.order_id,choice:v['order_'+o.order_id]})),guest_informed:!!v.guest_informed}),{success:async(result,f,status)=>{showResult(status,result);await reloadOverview();f.querySelector('button[type=submit]').hidden=true;}});
    }catch(e){panel.replaceChildren(node('p',e.message,'error'));panel.append(btn('Дахин ачаалах',()=>{panel.remove();openStay(s,parent);}));}
  }
  function paymentForm(parent,s,charge,rev){form(parent,'Төлбөрийн суваг',[select('channel','Суваг',channels())],'Дүн оруулах',async v=>v,{success:async(result,f)=>{f.remove();const channel=result.channel;const fields=[amount('amount_mnt','Авах дүн (₮)',charge.amount_mnt-charge.paid_mnt)];if(channel==='CASH')fields.push(field('received','Бэлэн мөнгийг биечлэн авсан','checkbox'));if(channel==='MANUAL_POS')fields.push(field('reference','POS баримтын дугаар'),field('terminal_id','Терминалын дугаар'),field('transacted_at','Гүйлгээний цаг (Улаанбаатар)','datetime-local'));
      form(parent,`${labels[channel]} төлбөр`,fields,'Төлбөр бүртгэх',v=>{const body={...rev,...v,charge_id:charge.id};let suffix;if(channel==='CASH'){suffix='cash-receipts';Object.assign(body,{channel:'CASH',purpose:'PAYMENT'});}else if(channel==='MANUAL_POS'){suffix='pos-payments';body.transacted_at=new Date(v.transacted_at+'+08:00').toISOString();}else{suffix='payment-intents';body.provider=channel;}return api(stayPath(s.stay_id,suffix),body);});}});}
  function correctionForm(parent,s,receipt,rev){form(parent,'Бүртгэлийн засвар',[field('replacement_amount_mnt','Зөв дүн (₮)','number',{min:0,value:receipt.amount_mnt}),select('channel','Зөв суваг',channels()),reason(),field('reference','Шинэ POS баримтын дугаар','text',{optional:true}),field('terminal_id','Шинэ POS терминал','text',{optional:true}),field('transacted_at','POS гүйлгээний цаг (Улаанбаатар)','datetime-local',{optional:true})],'Засвар хүсэх',v=>{const body={...rev,idempotency_key:v.idempotency_key,receipt_id:receipt.id,replacement_amount_mnt:v.replacement_amount_mnt,replacement_channel:v.channel,reason:v.reason};if(v.channel==='MANUAL_POS'&&v.replacement_amount_mnt>0)body.proof={reference:v.reference||'',terminal_id:v.terminal_id||'',transacted_at:v.transacted_at?new Date(v.transacted_at+'+08:00').toISOString():''};return api(stayPath(s.stay_id,'financial-corrections'),body);});}
  async function shiftTools(parent,seq){
    if(role('HOTEL_ADMIN')&&!overview.completion_only){
      command(parent,'Касс шинээр тохируулах',[field('code','Кассын код'),field('name','Кассын нэр'),field('physical_location','Байршил'),field('expected_float','Тохируулсан эхлэх үлдэгдэл (₮)','number',{min:0,value:0})],path('cash/drawers'));
      const policy=overview.shift_policy||[false,0];form(parent,'Ганцаар ажиллах горим',[select('single_worker','Горим',[['no','Ердийн хүлээлцэх'],['yes','Ганцаар ажиллахыг зөвшөөрөх']])],'Бодлого хадгалах',v=>api(path('shifts/policy'),{...v,expected_revision:policy[1],single_worker:v.single_worker==='yes'},'PUT'));
      for(const o of overview.opening_reviews||[]){const r=record(parent,'Анхны кассын зөрүү',`Тохируулсан ${money(o.expected)} · Тоолсон ${money(o.actual)} · Зөрүү ${money(o.variance)}`);for(const decision of ['approve','dispute'])command(r,decision==='approve'?'Зөрүүг хянаж батлах':'Зөрүүг маргаантай үлдээх',[reason()],path(`cash/drawers/${enc(o.drawer_id)}/opening-review/${decision}`),{expected_revision:0});}
    }
    if(role('RECEPTION')){
      const unused=overview.drawers.filter(d=>d.unused);if(unused.length)form(parent,'Анхны ээлж нээх',[select('drawer_id','Касс',choices(unused,'drawer_id','name')),field('actual','Биечлэн тоолсон бэлэн мөнгө (₮)','number',{min:0})],'Тооллогоор ээлж нээх',v=>api(path(`cash/drawers/${enc(v.drawer_id)}/open`),{actual:v.actual,idempotency_key:v.idempotency_key}));
    }
    if(overview.shifts?.some(s=>s.owner_id===overview.account_id&&s.state==='OPEN')||overview.custodies?.length){
      const fields=[field('actual','Биечлэн тоолсон бэлэн мөнгө (₮)','number',{min:0}),select('receiver_id','Хүлээн авагч',choices(overview.staff,'account_id',s=>`${s.email} · ${s.roles.map(r=>({RECEPTION:'Reception',MANAGER:'Менежер',HOTEL_ADMIN:'Админ',CLEANER:'Цэвэрлэгч',MANAGER_PLUS:'Менежер+'})[r]).join(', ')}`)),reason(),select('self_close','Хүлээлцэх төрөл',[['no','Өөр ажилтанд хүлээлгэх'],['yes','Зөвшөөрөгдсөн ганцаар хаалт']])];
      if(overview.custodies?.length)fields.push(select('custody_id','Хадгалж буй касс',[['','Өөрийн нээлттэй ээлж'],...choices(overview.custodies,'custody_id',c=>overview.drawers.find(d=>d.drawer_id===c.drawer_id)?.name||'Касс')],true));
      form(parent,'Ээлж / касс хүлээлгэн өгөх',fields,'Тооллого илгээж үйлдлүүдийг царцаах',v=>api(path('handovers'),{...v,self_close:v.self_close==='yes'}));
    }
    const inbox=await api(path('handovers'));if(seq!==generation)return;
    for(const h of inbox){const r=record(parent,'Хүлээн авах ээлж',time(h.submitted_at));form(r,'Биечлэн тоолох',[field('actual','Тоолсон мөнгө (₮)','number',{min:0})],'Тооллого бүртгэх',v=>api(path(`handovers/${enc(h.handover_id)}/counts`),v),{success:async(result,f,status)=>{showResult(status,result);form(r,'Хүлээлцэх шийдвэр',[select('accept','Шийдвэр',[['yes','Хүлээн авах'],['no','Өгөгчид буцаах']]),reason()],'Шийдвэр бүртгэх',v=>api(path(`handovers/${enc(h.handover_id)}/decision`),{...v,accept:v.accept==='yes',count_id:result.count_id}));}});}
    for(const s of overview.shifts||[]){const r=record(parent,`${overview.drawers.find(d=>d.drawer_id===s.drawer_id)?.name||'Касс'} · ${labels[s.state]}`,`${time(s.opened_at)} → ${time(s.closed_at)} · ${labels[s.review_state]}`);actions(r).append(btn('Ээлжийн тайлан',()=>guard(async()=>{try{const report=await api(path(`shifts/${enc(s.shift_id)}/report`));r.append(node('h3','Ээлжийн эх үүсвэрийн тайлан'),node('p',`Эхэлсэн ${money(report.opening_actual)} · Тайлангийн цаг ${time(report.as_of)}`),node('p','Эдгээр нь тухайн ээлжид бүртгэгдсэн эх үүсвэрийн дүн. Барьцаа, эхлэх үлдэгдэл, шилжүүлгийг орлого гэж нэгтгээгүй.'));table(r,'Хүлээн авсан мөнгө',['Зориулалт','Суваг','Нийт'],report.gross_receipts.map(x=>[labels[x.purpose],labels[x.channel],money(x.amount_mnt)]));table(r,'Кассын хөдөлгөөн',['Төрөл','Өөрчлөлт','Нөөцийн өөрчлөлт'],report.cash_movements.map(x=>[cashLabel(x.kind),money(x.posted_delta),money(x.reserved_delta)]));table(r,'Дууссан буцаалт',['Суваг','Дүн'],report.completed_refunds.map(x=>[labels[x.channel],money(x.amount_mnt)]));r.append(node('p',`Хүлээгдэж буй санхүүгийн ажил: ${report.pending_obligations.length}`));}catch(e){say(e.message,true);}})));
      if((manager()||role('HOTEL_ADMIN'))&&['MANAGER_REQUIRED','ADMIN_REQUIRED','DISPUTED'].includes(s.review_state)){for(const decision of ['approve','dispute'])command(r,decision==='approve'?'Ээлжийн тайланг батлах':'Маргаантай үлдээх',[reason()],path(`shifts/${enc(s.shift_id)}/review/${decision}`),{expected_revision:0});}
    }
    if(overview.shifts?.length===overview.limit)parent.append(node('p','Эхний 50 ээлж харагдаж байна. Дараагийн хэсгийг нээнэ үү.'));
    actions(parent).append(btn('Дараагийн ээлжүүд',()=>guard(async()=>{try{const after=overview.shifts.at(-1)?.shift_id||'';overview=await api(path(`operations?after=${enc(after)}`));await navigate('shift');}catch(e){say(e.message,true);}})));
  }
  function cashLabel(k){return ({INITIAL_FLOAT:'Анхны кассын санхүүжилт',GUEST_DEPOSIT:'Зочны барьцаа',GUEST_PAYMENT:'Зочны төлбөр',GUEST_REFUND:'Буцаалт',GUEST_REFUND_RESERVED:'Буцаалт нөөцлөх',GUEST_REFUND_RELEASED:'Нөөц чөлөөлөх',TRANSFER_IN:'Шилжүүлэг авсан',TRANSFER_OUT:'Шилжүүлэг өгсөн',CASH_DEBIT:'Кассын зарлага',GUEST_CORRECTION:'Бүртгэлийн залруулга'})[k]||'Кассын бусад хөдөлгөөн';}
  function table(parent,caption,headers,data){const wrap=node('div',undefined,'table-wrap');wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label',caption);const t=node('table'),head=node('thead'),tr=node('tr'),body=node('tbody');t.append(node('caption',caption));for(const label of headers){const th=node('th',label);th.scope='col';tr.append(th);}head.append(tr);for(const row of data){const tr=node('tr');for(const value of row)tr.append(node('td',value));body.append(tr);}t.append(head,body);wrap.append(t);parent.append(wrap);if(!data.length)parent.append(node('p','Бүртгэл алга.'));}
  function roomTools(parent,r){
    form(parent,`${r.number} өрөөний төлөв`,[select('action','Үйлдэл',[['DEACTIVATE','Идэвхгүй болгох / хаахаар хүлээлгэх'],['REACTIVATE','Дахин идэвхжүүлэх'],['CANCEL_RETIRING','Хаах хүсэлтийг цуцлах'],['REASSIGN_CATEGORY','Ангилал солих']]),select('category_id','Шилжүүлэх ангилал',[['','Ангилал солихгүй'],...choices(categories.filter(c=>c.status==='ACTIVE'),'category_id','name')],true),reason()],'Төлөв өөрчлөх',v=>api(path(`rooms/${enc(r.room_id)}/lifecycle`),{...v,expected_revision:r.revision}));
    command(parent,'Өрөөний тарифын override',[{...amount('hourly_price','Цагийн үнэ'),optional:true},{...amount('nightly_price','Хоногийн үнэ'),optional:true}],path(`rooms/${enc(r.room_id)}/tariffs`),{expected_revision:r.revision,hourly_price:null,nightly_price:null},'PUT');
    if(packageMnt===30000)actions(parent).append(btn('Өрөөний QR карт харах',()=>guard(async()=>{try{const card=await api(path(`rooms/${enc(r.room_id)}/guest-qr/card`));qrCard(parent,card);}catch(e){say(e.message,true);}})));
    if(packageMnt===30000)command(parent,'Өрөөний QR шинэчлэх',[reason()],path(`rooms/${enc(r.room_id)}/guest-qr`),{expected_revision:overview.qrs?.find(q=>q.room_id===r.room_id)?.revision||0});
    if(packageMnt===20000)command(parent,'Цэвэрлэгээг батлах',[],path(`rooms/${enc(r.room_id)}/manager-clean`),{expected_revision:r.revision});
    else command(parent,'Цэвэрлэгээ даалгах',[select('assignee_id','Цэвэрлэгч',choices(overview.staff.filter(s=>s.roles.includes('CLEANER')),'account_id','email'))],path(`rooms/${enc(r.room_id)}/cleaning-requests`),{expected_revision:r.revision});
    if(overview.mode==='MOCK_CASH_LEDGER'&&packageMnt>=25000){parent.append(node('p','Дараах минибарын тохиргоо нь бэлэн болоогүй үйлчилгээний туршилтын өгөгдөл.','notice'));
      form(parent,'Туршилтын минибарын нэг бараа',[field('product_id','Барааны код'),field('name','Барааны нэр'),amount('unit_price','Нэгжийн үнэ (₮)'),amount('opening_quantity','Өрөөнд байх тоо',2)],'Mock минибар тохируулах',v=>{const {idempotency_key,...item}=v;return api(path(`mock/rooms/${enc(r.room_id)}/minibar`),{items:[item],expected_revision:r.revision,idempotency_key},'PUT');});
      command(parent,'Туршилтын минибар унтраах',[],path(`mock/rooms/${enc(r.room_id)}/minibar`),{items:[],expected_revision:r.revision},'PUT');}
  }
  function managerTools(parent){
    const settings=overview.settings||[null,null,'12:00',0],deposit=overview.deposit_settings||[null,0];
    command(parent,'Буудлын тариф',[amount('hourly_price','Цагийн үндсэн үнэ (₮)',settings[0]),amount('nightly_price','Хоногийн үндсэн үнэ (₮)',settings[1]),field('checkout_time','Гарах тогтмол цаг (HH:MM)','text',{value:String(settings[2]).slice(0,5)})],path('rooms/settings'),{expected_revision:settings[3]},'PUT');
    command(parent,'Барьцааны үндсэн тохиргоо',[amount('amount_mnt','Барьцаа 50,000–100,000₮',deposit[0])],path('deposit-settings'),{expected_revision:deposit[1]},'PUT');
    command(parent,'Өрөөний ангилал үүсгэх',[field('name','Ангиллын нэр'),field('description','Тайлбар','textarea',{optional:true}),field('cleaning_buffer_minutes','Checkout дараах buffer (минут)','number',{min:0,value:30})],path('room-categories'));
    command(parent,'Өрөө бүртгэх',[field('number','Өрөөний дугаар'),field('floor','Давхар'),select('category_id','Ангилал',choices(categories.filter(c=>c.status==='ACTIVE'),'category_id','name'))],path('rooms'));
    for(const c of categories){const r=record(parent,c.name,labels[c.status]);form(r,'Ангиллын төлөв',[select('action','Үйлдэл',[['DEACTIVATE','Идэвхгүй болгох'],['REACTIVATE','Идэвхжүүлэх'],['CANCEL_RETIRING','Хаах хүсэлтийг цуцлах']]),reason()],'Төлөв өөрчлөх',v=>api(path(`room-categories/${enc(c.category_id)}/lifecycle`),{...v,expected_revision:c.revision}));command(r,'Ангиллын тариф',[{...amount('hourly_price','Цагийн үнэ'),optional:true},{...amount('nightly_price','Хоногийн үнэ'),optional:true}],path(`room-categories/${enc(c.category_id)}/tariffs`),{expected_revision:c.revision,hourly_price:null,nightly_price:null},'PUT');}
    if(overview.mode==='MOCK_CASH_LEDGER'){
      form(parent,'Туршилтын төлөгдсөн онлайн захиалга',[select('room_id','Өрөө',choices(rooms,'room_id','number')),select('kind','Хугацааны төрөл',[['HOURLY','Цагаар'],['NIGHTLY','Хоногоор']]),amount('duration_units','Цаг / хоногийн тоо',1),field('planned_checkin_at','Ирэх цаг (Улаанбаатар)','datetime-local')],'Mock захиалга үүсгэх',v=>api(path('mock/bookings'),{...v,planned_checkin_at:new Date(v.planned_checkin_at+'+08:00').toISOString()}));
      if(packageMnt===30000)form(parent,'Туршилтын рестораны захиалга',[select('stay_id','Байрлалт',choices(stays,'stay_id',s=>rooms.find(r=>r.room_id===s.room_id)?.number||'Өрөө')),field('restaurant_name','Рестораны нэр'),field('contact_phone','Холбоо барих утас','tel'),select('state','Төлөв',['PAID_PENDING','ACCEPTED','PREPARING','READY'].map(v=>[v,labels[v]])),reason()],'Mock захиалга үүсгэх',v=>{const {stay_id,...body}=v;return api(path(`mock/stays/${enc(stay_id)}/restaurant-orders`),body);});
    }
  }
  async function cleaningTools(parent,seq){
    if(role('CLEANER')&&packageMnt>=25000&&!overview.completion_only){const panel=node('div');parent.append(panel);actions(parent).append(btn('Минибарын тохиргооны ажлууд',()=>guard(()=>reconciliationTasks(panel,''))));}
    for(const i of overview.inspections||[]){const r=record(parent,`${i.room_number} · Минибар`,labels[i.state]);if(i.state==='REQUESTED'){
      const fields=(i.items||[]).map((item,index)=>field('used_'+index,`${item.name} — хэрэглэсэн тоо (0–${item.opening_quantity})`,'number',{min:0,value:0}));fields.push(field('no_consumption','Хэрэглээгүйг шалгаж баталсан','checkbox',{optional:true}));if(!role('CLEANER'))fields.push(field('exception_reason','Менежер орлосон шалтгаан','textarea'));
      form(r,'Минибарын mock тайлан',fields,'Шалгасан тайлан илгээх',v=>{const used={};i.items.forEach((item,index)=>used[item.product_id]=v['used_'+index]);return api(path(`mock/stays/${enc(i.stay_id)}/minibar-report`),{used,no_consumption:v.no_consumption,exception_reason:v.exception_reason||null,expected_revision:i.revision,idempotency_key:v.idempotency_key});});}}
    for(const t of overview.cleaning||[]){const r=record(parent,`Өрөөний ажил · ${labels[t.kind]}`,`Үлдсэн ${t.remaining}${t.product_id?' · '+t.product_id.split(':').at(-1):''}`);
      if(!t.started_at)command(r,'Цэвэрлэгээ эхлүүлэх',[],path(`cleaning/tasks/${enc(t.task_id)}/start`),{expected_revision:t.assignment_version});
      else command(r,`${labels[t.kind]} ажлыг батлах`,[field('quantity','Гүйцэтгэсэн тоо','number',{min:1,value:t.remaining}),...(t.kind==='COUNT'?[field('actual_count','Бодит тоо','number',{min:0})]:[])],path(`cleaning/tasks/${enc(t.task_id)}/post`),{expected_revision:t.assignment_version,action_id:t.action_id});}
    if(role('CLEANER')){const queue=await api(path('cleaning/checkouts'));if(seq!==generation)return;for(const c of queue.filter(c=>!c.task_id)){const r=record(parent,'Checkout дараах цэвэрлэгээ','Хариуцагчгүй ажил');command(r,'Ажлыг өөртөө авах',[],stayPath(c.stay_id,'checkout-cleaning/claim'));}}
    if(!overview.inspections?.length&&!overview.cleaning?.length)parent.append(node('p','Өөрт тань хуваарилсан нээлттэй ажил алга.'));
    if((overview.cleaning?.length||0)>=overview.limit||(overview.inspections?.length||0)>=overview.limit)actions(parent).append(btn('Дараагийн ажлууд',()=>guard(async()=>{try{const after=overview.cleaning?.at(-1)?.task_id||overview.inspections.at(-1).stay_id;overview=await api(path(`operations?after=${enc(after)}`));navigate('cleaning');}catch(e){say(e.message,true);}})));
  }
  function reconciliationPlan(parent,plan){
    if(!plan){parent.append(node('p','Тооллого хараахан даалгаагүй байна.'));return;}
    table(parent,'Тооллого ба шилжүүлэлтийн төлөвлөгөө',['Бараа','Бүртгэл','Бодит тоо','Зорилго','Шилжүүлэх','Агуулах'],plan.lines.map(i=>[i.name,i.baseline_quantity,i.actual_count??'Тоолоогүй',i.target_quantity,i.direction?`${labels[i.direction]} · ${i.quantity}`:'Шилжүүлэхгүй',i.warehouse_quantity]));
    if(plan.counts_complete&&!plan.counts_match)parent.append(node('p','Тооллогын зөрүүтэй. Бараа шилжүүлэхгүй, менежерт мэдэгдэнэ үү.','notice'));
    if(plan.shortage)parent.append(node('p','Агуулахын нөөц хүрэлцэхгүй. Бараа шилжүүлэхээс өмнө менежерт мэдэгдэж, мэдээллийг шинэчилнэ үү.','notice'));
  }
  async function reconciliationTasks(container,after){
    const parent=node('div'),seq=generation;container.replaceChildren(parent);parent.append(node('p','Тохиргооны ажлууд ачаалж байна…'));parent.setAttribute('aria-busy','true');
    try{
      const data=await api(path(`minibar/reconciliation/tasks?limit=20&after=${enc(after)}`));if(seq!==generation||!parent.isConnected)return;parent.replaceChildren();
      parent.append(node('h2','Минибарын тохиргооны ажлууд'));actions(parent).append(btn('Тохиргооны ажлуудыг шинэчлэх',()=>guard(()=>reconciliationTasks(container,after))));
      if(!data.items.length)parent.append(node('p','Өөрт тань оноосон тохиргооны ажил алга.'));
      for(const t of data.items){const r=record(parent,`${t.room_number} · Минибарын тооллого`,labels[t.request.state]);reconciliationPlan(r,t.plan);
        if(t.work_state!=='OPEN'){r.append(node('p','Энэ ажил эрхийн хяналт хүлээж байна.'));continue;}
        for(const line of t.plan.lines.filter(i=>i.actual_count===null))form(r,`${line.name} тоолох`,[field('actual_count','Өрөөнд бодитоор байгаа тоо','number',{min:0})],'Тооллогыг батлах',v=>api(path(`minibar/reconciliation/tasks/${enc(t.task_id)}/count`),{...v,assignment_version:t.assignment_version,action_id:line.action_id}),{success:async()=>{await reconciliationTasks(container,after);say('Бодит тооллого бүртгэгдлээ.');}});
        if(t.plan.counts_complete&&t.plan.counts_match&&!t.plan.shortage)form(r,'Бүрдлийг байршуулж дуусгах',[field('physical_transfers_confirmed','Дээрх бүх шилжүүлэлтийг биечлэн гүйцэтгэсэн','checkbox')],'Шилжүүлэлт, тохиргоог батлах',v=>api(path(`minibar/reconciliation/tasks/${enc(t.task_id)}/apply`),{...v,assignment_version:t.assignment_version,expected_revision:t.request.revision}),{success:async()=>{await reconciliationTasks(container,after);say('Барааны шилжүүлэлт, тохиргоо бүртгэгдлээ. Цэвэрлэгээг тусад нь батална.');}});
      }
      const pages=actions(parent);pages.append(btn('Тохиргооны эхний ажлууд',()=>guard(()=>reconciliationTasks(container,''))),btn('Тохиргооны дараагийн ажлууд',()=>guard(()=>reconciliationTasks(container,data.next_after))));pages.firstChild.disabled=!after;pages.lastChild.disabled=!data.next_after;
    }catch(e){if(seq===generation&&parent.isConnected)parent.replaceChildren(node('p',e.message,'error'),btn('Тохиргооны ажлыг дахин ачаалах',()=>reconciliationTasks(container,after)));}finally{parent.setAttribute('aria-busy','false');}
  }
  function qrCard(parent,card){
    const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg'),size=card.matrix.length;svg.setAttribute('viewBox',`0 0 ${size} ${size}`);svg.setAttribute('role','img');svg.setAttribute('aria-label',`${card.room_number} өрөөний QR`);svg.classList.add('qr-card');
    card.matrix.forEach((row,y)=>row.forEach((dark,x)=>{if(dark){const rect=document.createElementNS(ns,'rect');for(const [k,v] of Object.entries({x,y,width:1,height:1}))rect.setAttribute(k,String(v));svg.append(rect);}}));
    const box=record(parent,`${card.room_number} өрөөний нэвтрэх QR`,'Зочин QR уншуулаад Reception-оос авсан 6 оронтой нэг удаагийн кодоо оруулна.');box.append(svg);actions(box).append(btn('QR зураг татах',()=>{const copy=svg.cloneNode(true);copy.setAttribute('xmlns',ns);copy.setAttribute('style','background:white;fill:black');const blob=new Blob([new XMLSerializer().serializeToString(copy)],{type:'image/svg+xml'}),url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download='room-qr.svg';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}),btn('QR картыг хаах',()=>box.remove()));
  }
  function guestEntry(){let qr=new URLSearchParams(location.hash.slice(1)).get('qr')||'';history.replaceState(null,'',location.pathname);document.title='Зочны нэвтрэх — PRsystem';$('#login').replaceChildren();
    if(!/^[A-Za-z0-9_-]{20,128}$/.test(qr)){$('#login').append(node('h1','Өрөөний QR кодоо уншуулна уу'),node('p','Reception-оос тухайн өрөөний нэвтрэх мэдээллийг авна уу.'));return;}
    form($('#login'),'Өрөөндөө нэвтрэх',[field('code','Reception-оос авсан 6 оронтой код','text',{max:6})],'Нэвтрэх',v=>api('/guest/access',{qr_token:qr,code:v.code}),{login:true,success:async(result,f,status)=>{token=result.access_token;qr='';f.elements.code.value='';const session=await api('/guest/session');f.replaceChildren(node('h1',`${session.room_number} өрөөнд тавтай морил`),node('p',`Гарах цаг: ${time(session.planned_checkout_at)}`),node('p','Нэмэлт үйлчилгээг Reception-оос лавлана уу.'));}});
    window.addEventListener('pagehide',()=>{qr='';});
  }
  let onlineAfter='',customerAfter='',customerPhone='',portalQuery=null,geo=null;
  const localDate=v=>new Date(v+'+08:00').toISOString();
  async function imageValue(file){if(!(file instanceof File)||file.size>290000||!['image/png','image/jpeg'].includes(file.type))throw new Error('PNG эсвэл JPEG зураг сонгоно уу. Хэмжээ 290 KB-аас бага байна.');return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('Зургийг уншиж чадсангүй. Дахин сонгоно уу.'));reader.readAsDataURL(file);});}
  const photoField=()=>field('photo','Нийтлэх зураг · PNG/JPEG, 290 KB хүртэл','file',{accept:'image/png,image/jpeg'});
  function photos(parent,values,title){const row=node('div',undefined,'booking-photos');for(const value of values||[]){const img=node('img');img.src=value;img.alt=title;img.width=320;img.height=180;img.loading='lazy';img.addEventListener('error',()=>{img.alt='Зургийг ачаалж чадсангүй · '+title;});row.append(img);}parent.append(row);}
  function bookingSummary(parent,b){parent.append(node('p',`${time(b.quote.planned_checkin_at)} → ${time(b.quote.planned_checkout_at)} · ${money(b.quote.amount_mnt)}`));parent.append(node('p',`Захиалга: ${labels[b.booking_state]||b.booking_state} · Буцаасан: ${money(b.refunded_mnt)} · Буцаах үлдэгдэл: ${money(b.refund_remaining_mnt)}`));}
  async function onlineTools(parent,seq){
    const items=await api(path(`booking-holds?after=${enc(onlineAfter)}`));if(seq!==generation)return;
    parent.append(node('p','Баталгаажсан захиалгын төлбөр, төлөвлөсөн хугацаа өөрчлөгдөхгүй. Өрөөг check-in үед онооно.'));
    if(!items.length)parent.append(node('p','Энэ хэсэгт онлайн захиалга алга.'));
    for(const b of items){const r=record(parent,b.booking_id,labels[b.booking_state]||b.booking_state);bookingSummary(r,b);
      if(b.booking_state==='CONFIRMED'){
        if(role('RECEPTION'))actions(r).append(btn('Захиалгаар check-in хийх',()=>guard(()=>checkin(r,b))));
        const outcomes=[['NO_SHOW','Ирээгүй гэж бүртгэх'],...(manager()?[['CANCELLED_HOTEL','Буудлын шалтгаанаар цуцлах']]:[])];
        form(r,'Захиалгын эцсийн төлөв',[select('outcome','Үйлдэл',outcomes),reason()],'Сонгосон төлөвийг батлах',v=>api(path(`booking-holds/${enc(b.booking_id)}/terminal`),v));
        if(manager())command(r,'Нэмэлт төлбөргүй өндөр ангиллын өрөө зөвшөөрөх',[select('room_id','Өрөө',choices(rooms,'room_id',r=>`${r.number} · ${r.category_name}`)),reason()],path(`booking-holds/${enc(b.booking_id)}/upgrade`));
      }
    }
    const a=actions(parent);a.append(btn('Эхний хэсэг',()=>guard(()=>{onlineAfter='';navigate('online');})),btn('Дараагийн 50',()=>guard(()=>{onlineAfter=items.at(-1)?.booking_id||'';navigate('online');})));a.lastChild.disabled=items.length<50;
    if(manager()&&!overview.completion_only){
      form(parent,'Ангиллын түвшин тохируулах',[select('category_id','Ангилал',choices(categories,'category_id','name')),field('rank','Түвшин · өндөр тоо нь өндөр ангилал','number',{min:0}),field('expected_revision','Одоогийн хувилбар · анх 0','number',{min:0,value:0})],'Түвшин хадгалах',v=>{const {category_id,...body}=v;return api(path(`room-categories/${enc(category_id)}/booking-rank`),body,'PUT');});
      const settings=await api(path('booking-settings'));if(seq!==generation)return;
      parent.append(node('p',settings.categories.map(c=>`${categories.find(x=>x.category_id===c.category_id)?.name||c.category_id}: түвшний хувилбар ${c.rank_revision}, нийтлэлийн хувилбар ${c.publication_revision}`).join(' · ')));
      profileForm(parent,settings.profile);
      form(parent,'Ангиллыг нийтлэх',[select('category_id','Ангилал',choices(categories,'category_id','name')),photoField(),field('published','Ангиллыг нийтэд харуулах','checkbox',{optional:true}),field('expected_revision','Одоогийн хувилбар · анх 0','number',{min:0,value:0})],'Нийтлэх төлөв хадгалах',async v=>api(path(`room-categories/${enc(v.category_id)}/publication`),{photos:[await imageValue(v.photo)],published:v.published,expected_revision:v.expected_revision,idempotency_key:v.idempotency_key},'PUT'));
    }
  }
  function profileForm(parent,profile=null){const f=form(parent,'Буудлын нийтийн мэдээлэл',[field('name','Буудлын нэр'),field('address','Хаяг'),field('phone','Нийтийн утас','tel'),field('description','Тайлбар','textarea'),field('latitude','Өргөрөг','number',{decimal:true,min:-90}),field('longitude','Уртраг','number',{decimal:true,min:-180}),photoField(),field('published','Нийтэд харуулах','checkbox',{optional:true}),field('accepting','Онлайн захиалга авах','checkbox',{optional:true}),field('expected_revision','Одоогийн хувилбар · анх 0','number',{min:0,value:0})],'Профайл хадгалах',async v=>{const {photo,...body}=v;return api(path('booking-profile'),{...body,photos:[await imageValue(photo)]},'PUT');});if(profile)for(const [key,value] of Object.entries(profile)){const input=f.elements[key==='revision'?'expected_revision':key];if(input){if(input.type==='checkbox')input.checked=value;else input.value=value;}}}
  function portalTitle(title){document.title=title+' — PRsystem';$('#page-title').textContent=title;}
  function portalHome(message=''){
    document.querySelector('header span').textContent=portalMode==='booker'?'Буудлын онлайн захиалга':'Platform санхүү';document.querySelector('header .brand').href=location.pathname;
    generation++;dirty=false;$('#login').replaceChildren();$('#app').hidden=false;$('#navigation').replaceChildren();$('#content').replaceChildren();$('#mode').hidden=false;$('#page-title').textContent=portalMode==='booker'?'Буудал захиалах':'Захиалгын санхүү';document.title=$('#page-title').textContent+' — PRsystem';
    $('#logout').hidden=!token;$('#refresh').onclick=()=>guard(()=>portalMode==='finance'?financeTools():searchForm());
    $('#logout').onclick=()=>guard(async()=>{try{await api(portalMode==='booker'?'/booker/auth/logout':'/platform/auth/logout',{});}catch{}token='';tenant='';customerPhone='';portalHome();});
    const navigation=$('#navigation');navigation.append(btn('Нүүр',()=>guard(()=>portalHome())));
    if(portalMode==='booker'){
      if(token)navigation.append(btn('Миний захиалга',()=>guard(()=>{customerAfter='';myBookings();})));
      else navigation.append(btn('Нэвтрэх',()=>guard(()=>bookerLogin())),btn('Бүртгүүлэх / нууц үг сэргээх',()=>guard(()=>bookerRegister())));
      searchForm();
    }else if(!token)financeLogin();else financeTools();
    if(message)say(message,true);
  }
  function bookerLogin(){portalTitle('Зочны нэвтрэх');generation++;content().replaceChildren();form(content(),'Утсаар нэвтрэх',[field('phone','Утас','tel',{autocomplete:'username'}),field('password','Нууц үг','password',{autocomplete:'current-password'})],'Нэвтрэх',v=>api('/booker/auth/login',{phone:v.phone,password:v.password}),{login:true,success:async r=>{token=r.access_token;customerPhone=r.phone||'';portalHome();}});}
  function bookerRegister(){portalTitle('Утас баталгаажуулах');generation++;content().replaceChildren();form(content(),'Утас баталгаажуулах',[field('phone','Утас','tel',{autocomplete:'tel'}),select('purpose','Үйлдэл',[['REGISTER','Шинээр бүртгүүлэх'],['RESET','Нууц үг сэргээх']])],'Код хүсэх',v=>api('/booker/auth/challenge',{phone:v.phone,purpose:v.purpose,device:deviceId}),{login:true,success:async(r,f)=>{f.remove();form(content(),'6 оронтой код · 5 минут хүчинтэй',[field('code','Баталгаажуулах код','text',{max:6,autocomplete:'one-time-code'}),field('password','Шинэ нууц үг · 12–128 тэмдэгт','password',{autocomplete:'new-password'})],'Утас ба нууц үг батлах',v=>api('/booker/auth/complete',{challenge_id:r.challenge_id,code:v.code,password:v.password}),{login:true,success:async()=>{bookerLogin();say('Баталгаажлаа. Шинэ нууц үгээрээ нэвтэрнэ үү.');}});}});}
  const deviceId=crypto.randomUUID();
  function searchForm(){portalTitle('Буудал хайх');$('#refresh').onclick=()=>guard(()=>searchForm());generation++;content().replaceChildren();say('Огноо, байршлаа сонгоно уу.');
    const f=form(content(),'Буудал хайх',[field('arrival','Ирэх өдөр, цаг (Улаанбаатар)','datetime-local'),field('departure','Гарах өдөр','date'),field('query','Хот, дүүрэг эсвэл буудлын нэр','text',{optional:true})],'Буудал хайх',async v=>{
      const start=new Date(v.arrival+'+08:00'),end=new Date(v.departure+'T00:00:00+08:00'),day=new Date(v.arrival.slice(0,10)+'T00:00:00+08:00');const nights=(end-day)/86400000;
      if(!Number.isInteger(nights)||nights<1)throw new Error('Гарах өдрийг ирэх өдрөөс хойш сонгоно уу.');
      portalQuery={planned_checkin_at:start.toISOString(),nights,query:v.query||'',...(geo||{})};return await searchHotels('',false);
    },{success:async()=>{}});
    const clear=btn('Байршлын хайлт арилгах',()=>{f.elements.query.value='';f.elements.query.focus();geo=null;portalQuery=null;document.getElementById('hotel-results')?.replaceChildren();say('Хайлт арилсан. Огноогоо шалгаад дахин хайна уу.');});actions(f).append(clear);clear.hidden=!f.elements.query.value;f.elements.query.addEventListener('input',()=>{clear.hidden=!f.elements.query.value;});
    content().append(node('p','Одоогийн байршлыг зөвхөн буудал хүртэлх зайг тооцоход ашиглана. Зөвшөөрөхгүй бол хаягаар хайж болно.'));
    actions(content()).append(btn('Миний одоогийн байршлыг ашиглах',()=>{const seq=generation;if(!navigator.geolocation){say('Байршил дэмжихгүй байна. Хаягаар хайна уу.',true);return;}navigator.geolocation.getCurrentPosition(p=>{if(seq!==generation)return;geo={latitude:p.coords.latitude,longitude:p.coords.longitude};say('Байршил сонгогдлоо. Огноогоо оруулаад хайна уу.');},()=>{if(seq===generation)say('Байршлыг авч чадсангүй. Хаягаар хайна уу.',true);},{timeout:10000,maximumAge:0});}));
    const result=node('section');result.id='hotel-results';result.setAttribute('aria-live','polite');content().append(result);
  }
  async function searchHotels(after='',append=false){const seq=generation;const result=await api('/public/booking-hotels?'+new URLSearchParams({...portalQuery,after}));if(seq!==generation)return {};
    const target=$('#hotel-results');if(!append)target.replaceChildren();if(!result.items.length)target.append(node('p','Тохирох буудал олдсонгүй. Байршил эсвэл огноогоо өөрчилнө үү.'));
    for(const h of result.items){const r=record(target,h.name,`${h.address} · ${h.distance_km===undefined?'':h.distance_km+' км · '}${h.accepting?'Захиалга авч байна':'Онлайн захиалга авахгүй'}`);photos(r,h.photos,h.name);r.append(node('p',h.description),node('p',h.review_count?`${h.rating} · ${h.review_count} үнэлгээ`:'Нийтлэгдсэн үнэлгээ алга.'));const call=node('a','Залгах · '+h.phone);call.href='tel:'+h.phone;r.append(call);r.append(node('p',`Байршил: ${h.latitude}, ${h.longitude}`));
      for(const c of h.categories){const cat=record(r,c.name,`${money(c.quote.amount_mnt)} нийт · ${c.available} боломжит өрөө`);photos(cat,c.photos,c.name);if(c.available>0)actions(cat).append(btn(token?'Захиалах':'Нэвтэрч захиалах',()=>guard(()=>token?reviewBooking(cat,h,c):bookerLogin())));}
    }
    target.querySelector('[data-more]')?.remove();if(result.next_after){const more=btn('Дараагийн буудлууд',async()=>{more.disabled=true;try{await searchHotels(result.next_after,true);}catch(e){say(e.message,true);more.disabled=false;}});more.dataset.more='true';target.append(more);}return {};
  }
  function reviewBooking(parent,h,c){if(customerPhone)parent.append(node('p','Холбоо барих утас: '+customerPhone));parent.append(node('p',`Захиалга: ${h.name} · ${c.name} · ${time(c.quote.planned_checkin_at)} → ${time(c.quote.planned_checkout_at)} · ${money(c.quote.amount_mnt)}. Ирэхээс 24 ба түүнээс олон цагийн өмнө цуцалбал бүрэн буцаана; түүнээс хойш эхний шөнийн төлбөр суутгана. Тусдаа барьцаагүй.`));
    form(parent,'Захиалгаа хянаж үүсгэх',[select('provider','Төлөх суваг',[['QPAY','QPay'],['KHAAN','Хаан банк']]),field('accepted','Огноо, нийт дүн, цуцлалтын нөхцөлийг шалгасан','checkbox')],'Захиалга үүсгэх',v=>api(`/booker/hotels/${enc(h.tenant_id)}/bookings`,{category_id:c.category_id,planned_checkin_at:c.quote.planned_checkin_at,nights:c.quote.nights,provider:v.provider,idempotency_key:v.idempotency_key}),{success:async()=>{await myBookings();}});
  }
  async function myBookings(){portalTitle('Миний захиалга');$('#refresh').onclick=()=>guard(()=>myBookings());const seq=++generation;content().replaceChildren();say('Захиалга ачаалж байна…');try{const items=await api('/booker/bookings?after='+enc(customerAfter));if(seq!==generation)return;say('Өөрийн захиалгууд.');if(!items.length)content().append(node('p','Энэ хэсэгт захиалга алга.'));for(const b of items){const r=record(content(),b.booking_id,b.unavailable?'Мэдээлэл түр хаалттай':labels[b.booking_state]||b.booking_state);if(b.unavailable){r.append(node('p','Энэ буудлын мэдээлэл одоогоор харах боломжгүй. Буудалтай холбогдоно уу.'));continue;}bookingSummary(r,b);const url=s=>`/guest/booking-holds/${enc(b.tenant_id)}/${enc(b.booking_id)}${s}`;
      const refresh={success:async()=>myBookings()};
      form(r,'Төлбөрийн төлөв тулгах',[],'Тулгах',()=>api(url('/reconcile'),{},'POST',b.access_token),refresh);
      if(b.booking_state==='HOLDING')form(r,'Төлөх суваг солих',[select('provider','Шинэ суваг',[['QPAY','QPay'],['KHAAN','Хаан банк']])],'Суваг солих',v=>api(url('/attempts'),v,'POST',b.access_token),refresh);
      for(const a of b.attempts)r.append(node('p',`${labels[a.provider]} · ${labels[a.state]||a.state} · ${a.invoice_id?'Нэхэмжлэл үүссэн':'Нэхэмжлэл үүсээгүй'}`));
      if(['HOLDING','CONFIRMED'].includes(b.booking_state))form(r,'Цуцлалтын дүнг хянах',[],'Буцаах дүн харах',()=>api(url('/cancellation-preview'),undefined,'GET',b.access_token),{success:async(quote,f)=>{f.remove();r.append(node('p',`Цуцалбал буцаах: ${money(quote.refund_due)} · Суутгах: ${money(quote.retained_mnt)}. Хугацааны зааг өнгөрвөл дахин хянана.`));form(r,'Энэ захиалгыг цуцлах',[field('accepted','Цуцлалтын нөхцөл, буцаах дүнг хянасан','checkbox')],'Захиалгыг цуцлах',v=>api(url('/cancel'),{idempotency_key:v.idempotency_key,expected_refund_mnt:quote.refund_due},'POST',b.access_token),refresh);}});
      if(b.refund_remaining_mnt>0)form(r,'Буцаалтын төлөв тулгах',[],'Буцаалт тулгах',()=>api(url('/refunds/reconcile'),{},'POST',b.access_token),refresh);
    }const more=btn('Дараагийн 25',()=>guard(()=>{customerAfter=items.at(-1)?.booking_id||'';myBookings();}));more.disabled=items.length<25;actions(content()).append(btn('Эхний хэсэг',()=>guard(()=>{customerAfter='';myBookings();})),more);}catch(e){if(seq===generation)say(e.message,true);}}
  function financeLogin(){form(content(),'Platform санхүүгийн эрхээр нэвтрэх',[field('tenant_id','Буудлын код'),field('email','Имэйл','email',{autocomplete:'username'}),field('password','Нууц үг','password',{autocomplete:'current-password'}),field('code','MFA код','text',{max:6,autocomplete:'one-time-code'})],'Нэвтрэх',v=>{tenant=v.tenant_id;return api('/platform/auth/login',{email:v.email,password:v.password,code:v.code});},{login:true,success:async r=>{token=r.access_token;portalHome();}});}
  async function financeTools(bookingAfter='',batchAfter=''){if(!token)return financeLogin();const seq=++generation;content().replaceChildren();say('Санхүүгийн мэдээлэл ачаалж байна…');const fp=s=>`/platform/hotels/${enc(tenant)}/${s}`;
    form(content(),'MFA эрх шинэчлэх',[field('code','Шинэ MFA код','text',{max:6,autocomplete:'one-time-code'})],'Эрх баталгаажуулах',v=>api('/platform/auth/step-up',{code:v.code}),{login:true,success:async()=>financeTools()});
    const settings=node('details');settings.append(node('summary','Гэрээ, нийтлэл, хүлээн авагчийн тохиргоо'));content().append(settings);
    form(settings,'Шимтгэлийн гэрээ',[field('contract_id','Гэрээний дугаар'),field('rate_bps','Шимтгэл · 100 bps = 1%','number',{min:0}),field('valid_from','Эхлэх цаг (Улаанбаатар)','datetime-local'),field('valid_until','Дуусах цаг (Улаанбаатар)','datetime-local'),field('expected_revision','Одоогийн хувилбар · анх 0','number',{min:0,value:0})],'Гэрээ хадгалах',v=>api(fp('booking-contract'),{...v,valid_from:localDate(v.valid_from),valid_until:localDate(v.valid_until)},'PUT'));
    form(settings,'Буудлын нийтлэх эрх',[field('allowed','Нийтлэхийг зөвшөөрөх','checkbox',{optional:true}),field('expected_revision','Одоогийн хувилбар · анх 0','number',{min:0,value:0})],'Нийтлэх эрх хадгалах',v=>api(fp('booking-publication'),v,'PUT'));
    form(settings,'Банкны баталгаатай хүлээн авагч',[field('reference','Банкны баталгааны дугаар'),field('expected_revision','Одоогийн хувилбар · анх 0','number',{min:0,value:0})],'Хүлээн авагч хадгалах',v=>api(fp('booking-beneficiary'),v,'PUT'));
    try{const data=await api(fp('booking-finance')+'?'+new URLSearchParams({booking_after:bookingAfter,batch_after:batchAfter}));if(seq!==generation)return;say('Энэ хэсгийн захиалга, шилжүүлгийн багцууд.');for(const b of data.bookings){const r=record(content(),b.booking_id,labels[b.state]||b.state);if(b.net_mnt!==undefined)r.append(node('p',`Буудалд: ${money(b.net_mnt)} · Шимтгэл: ${money(b.commission_mnt)}`));if(b.batch_after)r.append(node('p',`Шилжүүлэгт орох хугацаа: ${time(b.batch_after)}`));if(b.reason)r.append(node('p','Төлбөр, буцаалт эсвэл банкны тулгалт дуусаагүй.'));form(r,'Settlement тооцох',[],'Тооцож хадгалах',()=>api(fp(`booking-holds/${enc(b.booking_id)}/settlement`),{}),{success:async()=>financeTools()});}
      form(content(),'Болсон хугацааны шилжүүлгийг багцлах',[],'Багц үүсгэх',v=>api(fp('booking-payouts'),v),{success:async()=>financeTools()});
      for(const b of data.batches){const r=record(content(),b.batch_id,`${money(b.amount_mnt)} · ${labels[b.state]||b.state} · Хүлээн авагчийн баталгаа: ${b.beneficiary||'—'}`);if(['BATCHED','FAILED'].includes(b.state))form(r,'Банкны шилжүүлэг илгээх',[field('accepted','Хүлээн авагч ба дүнг шалгасан','checkbox')],'Шилжүүлэг илгээх',v=>api(fp(`booking-payouts/${enc(b.batch_id)}/execute`),{idempotency_key:v.idempotency_key}),{success:async()=>financeTools()});if(b.attempt_id&&b.state==='PENDING')form(r,'Шилжүүлгийн төлөв тулгах',[],'Тулгах',()=>api(fp(`booking-payouts/${enc(b.batch_id)}/attempts/${enc(b.attempt_id)}/reconcile`),{}),{success:async()=>financeTools()});if(!['VOIDED','SUCCEEDED'].includes(b.state))form(r,'Төлөгдөөгүй багцыг цуцлах',[reason()],'Багцыг цуцлах',v=>api(fp(`booking-payouts/${enc(b.batch_id)}/void`),v),{success:async()=>financeTools()});}
    const pages=actions(content());pages.append(btn('Эхний хэсэг',()=>guard(()=>financeTools())));if(data.next_booking_after)pages.append(btn('Дараагийн захиалгууд',()=>guard(()=>financeTools(data.next_booking_after,batchAfter))));if(data.next_batch_after)pages.append(btn('Дараагийн багцууд',()=>guard(()=>financeTools(bookingAfter,data.next_batch_after))));
    }catch(e){if(seq===generation)say(e.message,true);}
  }

  for(const id of ['logout','refresh','keep','leave'])document.getElementById(id).disabled=false;
  if(portalMode)portalHome();else if(location.pathname==='/guest/entry')guestEntry();else showLogin();
})();
