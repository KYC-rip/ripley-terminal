// Host-owned adapter, not a UA spoof. Production signing and unrestricted network
// transports are deliberately absent until custody/security work is approved.
if (window === window.top) {
  const invoke=(cmd,args)=>window.__TAURI__.core.invoke(cmd,args);
  window.__rosNative={runtime:'tauri',caps:{tor:false,monero:false,browser:false,keychain:false},
    appVersion:()=>invoke('android_runtime_status').then(r=>r.appVersion),
    fetch:async()=>({ok:false,status:503,body:'Android POC: network transport disabled; use explicit stagenet diagnostics'}),
    getConfig:async()=>({routingMode:'clearnet',transportPolicy:'strict',allowWsOverTor:false}),
    torStatus:async()=>({status:'Disconnected'})};
  window.addEventListener('DOMContentLoaded',async()=>{
    const status=await invoke('android_runtime_status');
    window.__androidRuntime=Object.freeze(status);
    if(status.debugPoc) {
      try {await invoke('android_poc_wallet',{consent:'DENIED'});console.error('ANDROID_POC_UI_GUARD_UNEXPECTED_ALLOWED');}
      catch(e){console.info('ANDROID_POC_UI_GUARD',String(e));}
    }
    const link=document.createElement('a');
    link.textContent=status.debugPoc?'Android POC diagnostics':'Android POC · keyless';
    link.href=status.debugPoc?'/__android_poc.html':'#';
    link.style.cssText='position:fixed;right:8px;top:32px;z-index:2147483647;background:#151528;color:#8effc1;padding:7px;border:1px solid #8effc1;font:12px sans-serif';
    document.body.append(link);
  });
}
