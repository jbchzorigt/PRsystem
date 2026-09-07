'use strict';
(() => {
  const $=s=>document.querySelector(s), enc=encodeURIComponent;
  let token='',tenant='',overview=null,roles=[],packageMnt=0,view='guests',generation=0,dirty=false,pending=false;
  let rooms=[],categories=[],stays=[],bookings=[],roomAfter='',stayAfter='',selected=null;
  const money=n=>`${new Intl.NumberFormat('mn-MN').format(n)} ₮`;
  const time=v=>v?new Intl.DateTimeFormat('mn-MN',{timeZone:'Asia/Ulaanbaatar',dateStyle:'short',timeStyle:'short'}).format(new Date(v)):'—';
  const names={guests:'Зочин бүртгэх',rooms:'Өрөөнүүд',payments:'Төлбөр',restaurant:'Ресторан',shift:'Ээлж',manager:'Удирдлага',cleaning:'Цэвэрлэгээ'};
  const labels={ACTIVE:'Идэвхтэй',INACTIVE:'Идэвхгүй',RETIRING:'Хаахаар хүлээж буй',DIRTY:'Бохир',CLEANING:'Цэвэрлэж буй',CLEAN:'Цэвэр',OPEN:'Нээлттэй',CLOSED:'Хаасан',SUBMITTED:'Хүлээлгэн өгсөн',ACCEPTED:'Хүлээн авсан',RETURNED:'Буцаасан',PENDING:'Хүлээгдэж буй',CONFIRMED:'Баталгаажсан',APPLIED:'Ашигласан',CANCELLED:'Цуцалсан',SUCCEEDED:'Амжилттай',COMPLETED:'Дууссан',RESERVED:'Нөөцөлсөн',RELEASED:'Чөлөөлсөн',APPROVED:'Зөвшөөрсөн',REJECTED:'Татгалзсан',MANAGER_REQUIRED:'Менежерийн хяналт',ADMIN_REQUIRED:'Админы хяналт',NOT_REQUIRED:'Хяналт шаардахгүй',NOT_SUBMITTED:'Илгээгээгүй',DISPUTED:'Маргаантай',REQUESTED:'Тайлан хүлээж буй',REPORTED:'Тайлан ирсэн',CASH:'Бэлэн',MANUAL_POS:'Карт / POS',QPAY:'QPay',KHAAN:'Хаан банк',ROOM:'Өрөө',MINIBAR:'Минибар',PAYMENT:'Төлбөр',DEPOSIT:'Барьцаа',REFILL:'Нөхөн дүүргэх',COUNT:'Тоолох',RETURN:'Буцаах',HOURLY:'Цагаар',NIGHTLY:'Хоногоор',READY:'Бэлэн',PREPARING:'Бэлтгэж буй',PAID_PENDING:'Төлсөн, хүлээгдэж буй'};
  const errors={REVISION_CONFLICT:'Мэдээлэл өөрчлөгджээ. Шинэчилж, дүнгээ дахин шалгана уу.',FORBIDDEN:'Энэ үйлдлийг хийх эрх алга.',SUBSCRIPTION_EXPIRED:'Багцын хугацаа дууссан. Зөвхөн өмнө эхэлсэн ажлыг дуусгах эрх үйлчилнэ.',UNAUTHENTICATED:'Нэвтрэх эрх дууссан. Дахин нэвтэрнэ үү.',OPEN_SHIFT_REQUIRED:'Өөрийн нээлттэй ээлж шаардлагатай.',CHECKOUT_FINANCE_PENDING:'Төлбөр, барьцаа, хүлээгдэж буй үйлдлээ эхлээд шийдвэрлэнэ үү.',MINIBAR_REPORT_REQUIRED:'Минибарын баталгаажсан тайлан шаардлагатай.',MINIBAR_REPORT_LOCKED:'Төлбөр орсон тайланг энэ үйлдлээр засахгүй.',ROOM_NOT_READY:'Өрөөний цэвэрлэгээ, хугацаа, минибарын бэлэн байдлыг шалгана уу.',RESTAURANT_ACK_REQUIRED:'Дуусаагүй захиалга бүрийн сонголт, зочинд мэдээлсэн баталгааг оруулна уу.',GUARDIAN_REQUIRED:'18 нас хүрээгүй зочны асран хамгаалагчийг бүртгэнэ үү.',INVALID_GUEST_IDENTITY:'Зочны баримт болон төрсөн огноо тохирч байгаа эсэхийг шалгана уу.',AMENDMENT_PENDING:'Ирсэн цагийн засварын шийдвэрийг хүлээнэ үү.',INSUFFICIENT_CASH:'Кассын боломжит үлдэгдэл хүрэлцэхгүй.',PHYSICAL_COUNT_REQUIRED:'Системийн дүнг харахын өмнө биечлэн тоолж бүртгэнэ үү.',SERVICE_UNAVAILABLE:'Үйлчилгээ түр хариу өгөхгүй байна. Үр дүн тодорхойгүй тул энэ маягтаас дахин оролдож болно.',GUEST_PROVIDER_UNAVAILABLE:'Төлбөрийн үйлчилгээ энэ орчинд холбогдоогүй.',CHARGE_OVERPAYMENT:'Үлдэгдлээс давсан дүн оруулсан байна.',RECOUNT_REQUIRED:'Зөрүүтэй тул дахин биечлэн тоолно уу.'};
  function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n;}
  function say(text,error=false){$('#status').textContent=text;$('#status').className=error?'error':'';}
  function btn(text,fn,cls='secondary'){const b=node('button',text,cls);b.type='button';b.addEventListener('click',fn);return b;}
  function role(r){return roles.includes(r);} function manager(){return role('MANAGER')||(role('MANAGER_PLUS')&&packageMnt===30000);}
  function path(s){return `/hotels/${enc(tenant)}/${s}`;} function stayPath(s,suffix){return path(`stays/${enc(s)}/${suffix}`);}
  async function api(url,body,method='POST'){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
    try { const response=await fetch(url,{method:body===undefined?'GET':method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,cache:'no-store'});
      if(response.headers.get('X-PRsystem-Mode')==='MOCK_ONLY')$('#mode').hidden=false;
      const data=response.status===204?{}:await response.json();
      if(!response.ok){const e=new Error(errors[data.code]||(response.status===422?'Оруулсан талбар, дүн, хугацаагаа шалгана уу.':'Үйлдлийг бүртгэж чадсангүй. Мэдээллээ шинэчлээд дахин шалгана уу.'));e.code=data.code;e.status=response.status;if(response.status===401&&token){token='';dirty=false;pending=false;showLogin('Нэвтрэх эрх дууссан. Дахин нэвтэрнэ үү.');}throw e;}return data;
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
      if(spec.min!==undefined)input.min=spec.min;if(spec.max!==undefined)input.maxLength=spec.max;
      const label=node('label',spec.label+(spec.optional?' (сонголттой)':''));label.htmlFor=input.id;const error=node('p','', 'error');error.id=input.id+'-error';input.setAttribute('aria-describedby',error.id);
      wrap.append(label,input);
      if(spec.type==='password'){const reveal=btn('Нууц үг харуулах',()=>{const show=input.type==='password';input.type=show?'text':'password';reveal.textContent=show?'Нууц үг нуух':'Нууц үг харуулах';reveal.setAttribute('aria-pressed',String(show));});reveal.setAttribute('aria-pressed','false');wrap.append(reveal);}
      wrap.append(error);f.append(wrap);controls.set(spec.name,{input,error,spec});
      input.addEventListener('input',()=>{if(!opts.login)dirty=true;error.textContent='';input.removeAttribute('aria-invalid');});
    }
    const status=node('p','', 'result');status.setAttribute('role','status');const send=node('button',submit,'primary');send.type='submit';const actions=node('div',undefined,'actions');actions.append(send);if(!opts.login)actions.append(btn('Маягтыг хаах',()=>guard(()=>{f.remove();dirty=false;})));
    f.append(status,actions);parent.append(f);
    f.addEventListener('submit',async event=>{event.preventDefault();if(busy||pending)return;const values={};let first=null;
      for(const {input,error,spec} of controls.values()){const raw=spec.type==='checkbox'?input.checked:input.value.trim();let message='';
        if(!spec.optional&&(raw===''||raw===false))message='Энэ талбарыг бөглөнө үү.';
        if(raw!==''&&spec.type==='number'&&(!Number.isSafeInteger(Number(raw))||Number(raw)<(spec.min??0)))message='Зөв бүхэл дүн оруулна уу.';
        if(raw!==''&&spec.type==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw))message='Имэйл хаягаа шалгана уу.';
        if(message){error.textContent=message;input.setAttribute('aria-invalid','true');first??=input;}
        if(raw!==''||!spec.optional)values[spec.name]=spec.type==='number'?Number(raw):raw;
      }
      if(first){status.textContent='Алдаатай талбарыг засна уу.';first.focus();return;}
      const serialized=JSON.stringify(values);if(fingerprint&&serialized!==fingerprint)key=crypto.randomUUID();fingerprint=serialized;
      busy=true;pending=true;send.disabled=true;f.setAttribute('aria-busy','true');status.textContent='Бүртгэж байна…';
      try{const result=await action({...values,idempotency_key:key});if(!f.isConnected)return;dirty=false;status.textContent='Серверт бүртгэгдлээ.';key=crypto.randomUUID();fingerprint='';
        for(const {input,spec} of controls.values())if(spec.type==='password'){input.value='';input.type='password';}
        if(opts.success)await opts.success(result,f,status);else {showResult(status,result);await reloadOverview();}
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
  window.addEventListener('pagehide',()=>{token='';tenant='';$('#content').replaceChildren();$('#login').replaceChildren();});
  function showLogin(message=''){generation++;$('#app').hidden=true;$('#logout').hidden=true;$('#login').hidden=false;$('#content').replaceChildren();$('#login').replaceChildren();overview=null;roles=[];selected=null;rooms=[];stays=[];categories=[];bookings=[];
    form($('#login'),'Ажилтнаар нэвтрэх',[field('tenant_id','Буудлын код'),field('email','Имэйл','email',{autocomplete:'username'}),field('password','Нууц үг','password',{autocomplete:'current-password'})],'Нэвтрэх',async v=>api('/auth/login',{tenant_id:v.tenant_id,email:v.email,password:v.password}),{login:true,success:async(r,f,status)=>{token=r.access_token;tenant=f.elements.tenant_id.value.trim();const me=await api('/auth/me');roles=me.roles;$('#login').hidden=true;$('#app').hidden=false;$('#logout').hidden=false;f.remove();await reloadOverview();await navigate(role('RECEPTION')?'guests':manager()?'manager':role('HOTEL_ADMIN')?'shift':'cleaning');}});
    if(message)$('#login').prepend(node('p',message,'notice'));
  }
  async function reloadOverview(){overview=await api(path('operations'));roles=overview.roles;packageMnt=overview.package_mnt;$('#mode').hidden=overview.mode!=='MOCK_CASH_LEDGER';navigation();}
  function navigation(){const nav=$('#navigation');nav.replaceChildren();let links=[];if(role('RECEPTION')||manager())links=['guests','rooms','payments',...(packageMnt===30000?['restaurant']:[])];if(role('RECEPTION')||manager()||role('HOTEL_ADMIN'))links.push('shift');if(manager())links.push('manager');if(role('CLEANER')||manager())links.push('cleaning');
    for(const name of links){const a=node('a',names[name]);a.href=`#${name}`;if(name===view)a.setAttribute('aria-current','page');a.onclick=e=>{e.preventDefault();guard(()=>navigate(name));};nav.append(a);}
  }
  async function navigate(next){const seq=++generation;view=next;dirty=false;history.replaceState(null,'',`#${next}`);document.title=`${names[next]} — PRsystem`;navigation();$('#page-title').textContent=names[next];$('#page-title').focus();$('#content').replaceChildren();$('#content').setAttribute('aria-busy','true');say('Мэдээлэл ачаалж байна…');
    try{await render(next,seq);if(seq===generation)say('Мэдээлэл шинэчлэгдсэн.');}catch(e){if(seq===generation)say(e.message,true);}finally{if(seq===generation)$('#content').setAttribute('aria-busy','false');}
  }
  $('#refresh').onclick=()=>guard(async()=>{try{await reloadOverview();await navigate(view);}catch(e){say(e.message,true);}});
  $('#logout').onclick=()=>guard(async()=>{try{await api('/auth/logout',{});}catch{}token='';tenant='';dirty=false;showLogin();});
  const content=()=>$('#content');
  function record(parent,title,description){const r=node('article',undefined,'record');r.append(node('h3',title),node('p',description));parent.append(r);return r;}
  function actions(r){const a=node('div',undefined,'actions');r.append(a);return a;}
  function choices(items,key,label){return items.map(x=>[x[key],typeof label==='function'?label(x):x[label]]);}
  function select(name,label,options,optional=false){return field(name,label,'select',{options,optional});}
  function command(parent,title,fields,url,base={},method='POST',opts={}){return form(parent,title,fields,'Бүртгэх',v=>api(url,{...base,...v},method),opts);}
  async function roomData(){[rooms,categories,stays]=await Promise.all([api(path(`rooms?limit=100&after=${enc(roomAfter)}`)),api(path('room-categories')),api(path(`stays/active?limit=100&after=${enc(stayAfter)}`))]);}
  function pager(parent,kind,items,key){const a=actions(parent);a.append(btn('Эхний хэсэг',()=>guard(()=>{if(kind==='room')roomAfter='';else stayAfter='';navigate(view);})),btn('Дараагийн 100',()=>guard(()=>{if(kind==='room')roomAfter=items.at(-1)[key];else stayAfter=items.at(-1)[key];navigate(view);})));a.lastChild.disabled=items.length<100;parent.append(node('p',`Энэ хэсэгт ${items.length} бүртгэл.`, 'muted'));}
  async function render(next,seq){const parent=content();
    if(['guests','rooms','payments','restaurant','manager'].includes(next)){await roomData();if(seq!==generation)return;}
    if(next==='guests'){
      parent.append(node('p','Нэг байрлалтад нэг үндсэн зочин бүртгэнэ. Ирсэн цаг, төлөвлөсөн гарах цаг болон тарифыг сервер баталгаажуулна.'));
      if(role('RECEPTION')){actions(parent).append(btn('Walk-in зочин бүртгэх',()=>guard(()=>checkin(parent))),btn('POS / банкны барьцаа бэлтгэх',()=>guard(()=>fundingForm(parent))));
        for(const f of overview.funding||[]){const r=record(parent,'Check-in барьцаа',`${labels[f.channel]} · ${money(f.amount_mnt)} · ${labels[f.state]}`);if(f.state==='PENDING')form(r,'Барьцааны банкны төлөв тулгах',[],'Тулгах',()=>api(path(`check-in-funding/${enc(f.funding_id)}/reconcile`),{}));}
      }
      if(!stays.length)parent.append(node('p','Одоогоор идэвхтэй байрлалт алга.'));
      for(const s of stays){const room=rooms.find(r=>r.room_id===s.room_id);const r=record(parent,`${room?.number||'Өрөө'} · ${labels[s.kind]}`,`${time(s.actual_checkin_at)} → ${time(s.planned_checkout_at)} · ${money(s.amount_mnt)}${s.overdue?' · Хугацаа хэтэрсэн':''}`);actions(r).append(btn('Байрлалт нээх',()=>guard(()=>openStay(s,r))));}pager(parent,'stay',stays,'stay_id');
      bookings=await api(path('bookings'));if(seq!==generation)return;
      parent.append(node('h2','Баталгаажсан онлайн захиалга'));
      for(const b of bookings){const r=record(parent,`${rooms.find(r=>r.room_id===b.room_id)?.number||'Өрөө'} · ${labels[b.state]||b.state}`,`${time(b.planned_checkin_at)} → ${time(b.planned_checkout_at)}`);if(role('RECEPTION')&&b.state==='CONFIRMED')actions(r).append(btn('Захиалгаар check-in хийх',()=>guard(()=>checkin(r,b))));}
    } else if(next==='rooms'){
      for(const r of rooms){const card=record(parent,`${r.number} · ${r.category_name}`,`${labels[r.status]} · ${labels[r.cleaning_state]} · ${r.minibar_mode==='OFF'?'Минибаргүй':'Туршилтын минибартай'}`);const a=actions(card);
        const s=stays.find(s=>s.room_id===r.room_id);if(s)a.append(btn('Байрлалт нээх',()=>guard(()=>openStay(s,card))));
        else if(role('RECEPTION')&&r.status==='ACTIVE')a.append(btn('Зочин бүртгэх',()=>guard(()=>checkin(card,null,r))));
        if(manager()){a.append(btn('Өрөө удирдах',()=>guard(()=>roomTools(card,r))));}
      }pager(parent,'room',rooms,'room_id');
    } else if(next==='payments'||next==='restaurant'){
      parent.append(node('p',next==='restaurant'?'Рестораны төлбөр буудлын касст орохгүй. Checkout хийхдээ дуусаагүй захиалга бүрийн сонголтыг зочинд мэдээлнэ.':'Байрлалтаа сонгоод нэхэмжлэл, барьцаа, буцаалт болон засварыг бүртгэнэ.'));
      if(!stays.length)parent.append(node('p','Идэвхтэй байрлалт алга.'));
      form(parent,'Байрлалт сонгох',[select('stay_id','Өрөө / байрлалт',choices(stays,'stay_id',s=>`${rooms.find(r=>r.room_id===s.room_id)?.number||'Өрөө'} · ${time(s.actual_checkin_at)}`))],'Нээх',async v=>{const s=stays.find(s=>s.stay_id===v.stay_id);await openStay(s,parent);return {};},{success:async()=>{}});
    } else if(next==='shift')await shiftTools(parent,seq);
    else if(next==='manager')managerTools(parent);
    else if(next==='cleaning')await cleaningTools(parent,seq);
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
      if(!booking)fields.push(select('room_id','Өрөө',choices(room?[room]:rooms.filter(r=>r.status==='ACTIVE'),'room_id','number')),select('kind','Хугацааны төрөл',[['HOURLY','Цагаар'],['NIGHTLY','Хоногоор']]),amount('duration_units','Цаг / хоногийн тоо',1),select('deposit_channel','Барьцаа авах суваг',[["CASH","Бэлэн"],["FUNDING","Баталгаажсан POS / банкны барьцаа"]]),amount('deposit_amount','Бэлнээр авсан барьцаа (₮)'),field('received','Бэлэн барьцааг биечлэн авсан','checkbox',{optional:true}),select('funding_id','Өмнө баталгаажсан барьцаа',[['','Сонгоогүй'],...choices(overview.funding?.filter(f=>f.state==='CONFIRMED')||[],'funding_id',f=>`${rooms.find(r=>r.room_id===f.room_id)?.number||'Өрөө'} · ${labels[f.channel]} · ${money(f.amount_mnt)}`)],true));
      const depositField=fields.find(f=>f.name==='deposit_amount');if(depositField)depositField.optional=true;
      fields.push(field('actual_checkin_at','Өмнө ирсэн цаг (Улаанбаатар)','datetime-local',{optional:true}),field('backdate_reason','Өмнө ирсэн цагийн шалтгаан','textarea',{optional:true}));
      form(start,booking?'Онлайн захиалгаар зочин бүртгэх':'Walk-in зочин бүртгэх',fields,'Check-in баталгаажуулах',async v=>{
        const guest={identity_type:r.identity_type};for(const key of ['family_name','given_name','date_of_birth','nationality','document_number','issuing_country','expiry_date','document_type','issuing_authority','no_document_reason','note'])if(v[key])guest[key]=v[key];
        if(v.guardian_name||v.guardian_phone||v.guardian_relationship)guest.guardian={name:v.guardian_name||'',phone:v.guardian_phone||'',relationship:v.guardian_relationship||''};
        const body={guest,idempotency_key:v.idempotency_key};if(v.actual_checkin_at)body.actual_checkin_at=new Date(v.actual_checkin_at+'+08:00').toISOString();if(v.backdate_reason)body.backdate_reason=v.backdate_reason;
        if(!booking){Object.assign(body,{room_id:v.room_id,kind:v.kind,duration_units:v.duration_units});if(v.deposit_channel==='CASH')body.deposit={channel:'CASH',amount_mnt:v.deposit_amount||0,received:v.received};else body.funding_id=v.funding_id||'';}
        return api(booking?path(`bookings/${enc(booking.booking_id)}/check-in`):path('stays/check-in'),body);
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
        a.append(btn('Нэг удаагийн код өгөх',()=>guard(()=>command(panel,'Зочны нэвтрэх код',[],prefix('guest-codes')))));
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
      for(const p of finance.payment_intents){const r=record(panel,`${labels[p.provider]} · ${money(p.amount_mnt)}`,labels[p.state]||p.state);if(p.state==='PENDING'&&role('RECEPTION'))form(r,'Банкны төлөв тулгах',[],'Тулгах',()=>api(prefix(`payment-intents/${enc(p.id)}/reconcile`),{}));}
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
  function correctionForm(parent,s,receipt,rev){form(parent,'Бүртгэлийн засвар',[amount('replacement_amount_mnt','Зөв дүн (₮)',receipt.amount_mnt),select('channel','Зөв суваг',channels()),reason(),field('reference','Шинэ POS баримтын дугаар','text',{optional:true}),field('terminal_id','Шинэ POS терминал','text',{optional:true}),field('transacted_at','POS гүйлгээний цаг (Улаанбаатар)','datetime-local',{optional:true})],'Засвар хүсэх',v=>{const body={...rev,idempotency_key:v.idempotency_key,receipt_id:receipt.id,replacement_amount_mnt:v.replacement_amount_mnt,replacement_channel:v.channel,reason:v.reason};if(v.channel==='MANUAL_POS')body.proof={reference:v.reference||'',terminal_id:v.terminal_id||'',transacted_at:v.transacted_at?new Date(v.transacted_at+'+08:00').toISOString():''};return api(stayPath(s.stay_id,'financial-corrections'),body);});}
  async function shiftTools(parent,seq){
    if(role('HOTEL_ADMIN')){
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
  for(const id of ['logout','refresh','keep','leave'])document.getElementById(id).disabled=false;
  showLogin();
})();
