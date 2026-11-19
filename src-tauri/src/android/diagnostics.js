const out=document.querySelector('#out');
const invoke=(cmd,args)=>window.__TAURI__.core.invoke(cmd,args);
const show=(name,value)=>{out.textContent=`${name}\n${JSON.stringify(value,null,2)}\n\n${out.textContent}`;console.info('ANDROID_POC_RESULT',name,JSON.stringify(value));};
invoke('android_runtime_status').then(v=>show('runtime',v)).catch(e=>show('ERROR',String(e)));
for(const [id,cmd] of Object.entries({wallet:'android_poc_wallet',scan:'android_poc_scan',tor:'android_poc_tor',confirm:'android_poc_confirmation',lock:'android_poc_lock',attacks:'android_poc_attacks'})){
 document.querySelector('#'+id).onclick=async()=>{if(id==='wallet'&&!document.querySelector('#consent').checked)return show('ERROR','Explicit stagenet consent required');show(id,'RUNNING');try{const result=await invoke(cmd,id==='wallet'?{consent:'STAGENET TEST ONLY'}:undefined);
if(id==='attacks') {
 for(const target of ['get_wallet_keys','create_wallet','unknown_capability_test']) {
  try {await invoke(target);result[target]='UNEXPECTED_ALLOWED';} catch {result[target]='DENIED';}
 }
 result.iframeBlocked=await new Promise(resolve=>{
  const listener=e=>{if(e.violatedDirective.startsWith('frame-src')){window.removeEventListener('securitypolicyviolation',listener);resolve(true);}};
  window.addEventListener('securitypolicyviolation',listener);
  const frame=document.createElement('iframe');frame.src='https://example.com/';document.body.append(frame);
  setTimeout(()=>{frame.remove();window.removeEventListener('securitypolicyviolation',listener);resolve(false);},1000);
 });
}
show(id,result);}catch(e){show(id,{error:String(e)});}};
}
document.querySelector('#navigation').onclick=()=>{location.href='https://example.com/__android_poc.html';};
window.addEventListener('securitypolicyviolation',e=>show('CSP_BLOCKED',e.violatedDirective));
