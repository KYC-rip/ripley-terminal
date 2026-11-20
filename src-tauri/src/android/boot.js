// Android Terminal compatibility adapter. DEBUG desktop layout is selected by
// Rust, not by reporting a false runtime. Wallet custody remains DEBUG stagenet.
async function F(a, t, o = {}) { var s; const d = o.account_index || 0, e = r => r || []; switch (t) {
    case "get_accounts": return { subaddress_accounts: e(await a("get_accounts")).map(n => ({ account_index: n.index, label: n.label, balance: n.balance, unlocked_balance: n.unlockedBalance ?? n.unlocked_balance ?? "0", base_address: n.baseAddress ?? n.base_address ?? "" })) };
    case "get_balance":
    case "getbalance": {
        const r = await a("get_balance", { accountIndex: d }), n = e(await a("get_subaddresses", { accountIndex: d }));
        return { total_balance: r.total, unlocked_balance: r.unlocked, per_subaddress: n.map(l => ({ address_index: l.index, balance: Number(l.balance) || 0, unlocked_balance: Number(l.unlockedBalance ?? l.unlocked_balance) || 0 })) };
    }
    case "get_height": return { height: await a("get_height") };
    case "get_address": {
        const r = e(await a("get_subaddresses", { accountIndex: d }));
        return { address: ((s = r[0]) == null ? void 0 : s.address) ?? "", addresses: r.map(n => ({ address_index: n.index, address: n.address, label: n.label, used: n.isUsed ?? n.is_used ?? !1 })) };
    }
    case "get_subaddresses": return { addresses: e(await a("get_subaddresses", { accountIndex: d })).map(n => ({ address_index: n.index, address: n.address, label: n.label, used: n.isUsed ?? n.is_used ?? !1, balance: n.balance, unlocked_balance: n.unlockedBalance ?? n.unlocked_balance })) };
    case "get_transfers": return await a("get_transactions", { accountIndex: d });
    case "incoming_transfers": return await a("get_outputs", { accountIndex: d });
    case "create_address": return { address: await a("create_subaddress", { label: o.label || "Payment", accountIndex: o.account_index }) };
    case "label_address": {
        const r = o.index;
        return await a("set_subaddress_label", { accountIndex: (r == null ? void 0 : r.major) ?? 0, index: (r == null ? void 0 : r.minor) ?? 0, label: o.label || "" }), {};
    }
    case "get_fee_estimate": try {
        return { fees: await a("estimate_fees") };
    }
    catch {
        return { fees: [] };
    }
    case "get_tx_key": return { tx_key: await a("get_tx_key", { txid: o.txid }) };
    case "get_tx_proof": return { signature: await a("get_tx_proof", { txid: o.txid, address: o.address, message: o.message }) };
    case "sign_message": return await a("sign_message", { address: o.address, message: o.message });
    case "check_tx_key": return await a("check_tx_key", { txid: o.txid, txKey: o.tx_key, address: o.address });
    case "check_tx_proof": return await a("check_tx_proof", { txid: o.txid, address: o.address, message: o.message, signature: o.signature });
    case "create_account": return await a("create_account", { label: o.label || "Account" });
    case "label_account": return await a("rename_account", { accountIndex: o.account_index, newLabel: o.label }), {};
    case "rescan_blockchain": return await a("rescan", { height: o.height || 0 }), {};
    case "sweep_all": {
        const r = await a("sweep_all", { address: o.address, accountIndex: o.account_index ?? d, priority: o.priority ?? 0, subaddrIndices: o.subaddr_indices ?? null });
        return { tx_hash_list: r, tx_hash: r[0] };
    }
    case "sweep_single": {
        const r = await a("sweep_single", { address: o.address, keyImage: o.key_image, priority: o.priority ?? 0 });
        return { tx_hash_list: r, tx_hash: r[0] };
    }
    case "transfer":
    case "transfer_split": {
        const r = o.destinations || [], n = await a("prepare_transfer", { destinations: r.map(i => ({ address: i.address, amount: String(i.amount) })), accountIndex: o.account_index ?? d, priority: o.priority ?? 0 }), l = r.length === 1 ? r[0].address : `${r.length} destinations`, f = await a("relay_transfer", { txMetadata: n.txMetadata, to: l, amount: n.amount, fee: n.fee });
        return { tx_hash_list: [f], tx_hash: f, fee: n.fee, amount: n.amount };
    }
    case "sweep_dust":
    case "relay_tx": throw new Error(`spend method '${t}' is not bridged — use platform.wallet.send (gated) instead`);
    default: throw new Error(`wallet.rpc: unsupported method '${t}'`);
} }

if(window===window.top){
 const raw=window.__TAURI__.core.invoke;
 const invoke=async(c,a)=>{try{const result=await raw(c,a);if(window.__ANDROID_STAGENET_DEBUG__&&c==='get_outputs')console.info('ANDROID_OUTPUT_SCHEMA',JSON.stringify({hasTransfersArray:Array.isArray(result?.transfers)}));return result;}catch(e){if(['create_wallet','open_wallet','get_balance','get_accounts'].includes(c))console.info('ANDROID_WALLET_DENIED',JSON.stringify({command:c,code:e?.code||'IPC_ERROR'}));if(e&&typeof e==='object'&&e.code){const x=new Error(`[${e.code}] ${e.message}`);Object.assign(x,e);throw x;}throw e;}};
 const rpc=(method,args)=>F(invoke,method,args||{});
 const action=async(mode,p={})=>{try{switch(mode){
 case 'create':{const id=`vault_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;await invoke('create_wallet',{name:id,password:p.pwd,seed:p.seed??null,restoreHeight:p.height??null,fresh:p.fresh??null});const ids=await invoke('get_identities');await invoke('save_identities',{ids:[...ids,{id,name:p.name||id,created:Date.now()}]});await invoke('switch_identity',{id});await invoke('open_wallet',{name:id,password:p.pwd});return {success:true,id};}
 case 'open':await invoke('open_wallet',{name:p.name,password:p.pwd});return {success:true};
 case 'close':await invoke('close_wallet');return {success:true};
 case 'verify':return {success:await invoke('verify_password',{identityId:p.id,password:p.pwd})};
 case 'reselect':await invoke('reselect_node');return {success:true};
 case 'mnemonic':await invoke('get_mnemonic');return {success:false};
 default:throw new Error(`[UNSUPPORTED_ANDROID] wallet action ${mode} not implemented`);
 }}catch(e){return {success:false,error:e.message||String(e)}}};
 const browser={open:(url,x,y,w,h,bg)=>invoke('browser_embed_open',{url,x,y,w,h,bg}),bounds:(x,y,w,h)=>invoke('browser_embed_bounds',{x,y,w,h}),navigate:url=>invoke('browser_embed_navigate',{url}),visible:visible=>invoke('browser_embed_visible',{visible}),setZoom:zoom=>invoke('browser_embed_zoom',{zoom}),close:()=>invoke('browser_embed_close')};
 window.__rosNative={runtime:'tauri',caps:{tor:false,monero:false,browser:true,keychain:false,browserMode:'isolated-activity',nativeWalletTestMode:window.__ANDROID_STAGENET_DEBUG__===true},
 appVersion:()=>invoke('android_runtime_status').then(s=>s.appVersion),fetch:req=>invoke('ros_native_fetch',{req}),fetchBytes:req=>invoke('ros_native_fetch_bytes',{req}),
 getConfig:()=>invoke('get_config'),setConfig:config=>invoke('save_config',{config}),torStatus:async()=>({status:'disconnected',supported:false}),
 openBrowser:url=>invoke('open_native_browser',{url}),openExternal:url=>invoke('open_external_url',{url}),embedBrowser:browser,
 onLog:fn=>window.__TAURI__.event.listen('core-log',e=>fn(e.payload)),
 wallet:{rpc,action,identities:()=>invoke('get_identities'),uplink:()=>invoke('get_sync_status'),send:{prepare:(destinations,accountIndex,priority)=>invoke('prepare_transfer',{destinations,accountIndex,priority}),relay:(txMetadata,to,amount,fee)=>invoke('relay_transfer',{txMetadata,to,amount,fee})}}};
 // Startup IPC is async, but capability selection must precede module bootstrap.
 // Native DEBUG entry point sets this marker in an initialization script; release omits it.
 window.__rosNative.caps.monero=window.__ANDROID_STAGENET_DEBUG__===true;
 const originalFetch=window.fetch.bind(window);
 // Frontends revoke download URLs immediately after anchor.click(). Hold the
 // Blob itself synchronously, not a later fetch of an already-revoked URL.
 const downloadBlobs=new Map(),createBlobURL=URL.createObjectURL.bind(URL),revokeBlobURL=URL.revokeObjectURL.bind(URL);
 URL.createObjectURL=b=>{const u=createBlobURL(b);if(b instanceof Blob)downloadBlobs.set(u,b);return u;};
 URL.revokeObjectURL=u=>{downloadBlobs.delete(String(u));revokeBlobURL(u);};
 if(window.__ANDROID_STAGENET_DEBUG__) Promise.all([
 ['unknown','__unknown_android_capability__',{}],['private-keys','get_wallet_keys',{}],['mnemonic','get_mnemonic',{}],['signing','prepare_transfer',{}],
 ['mainnet','save_config',{config:{network:'mainnet'}}],['tor-no-bypass','save_config',{config:{routingMode:'tor'}}],
 ['post-no-relay','ros_native_fetch',{req:{url:'https://example.com/',method:'POST'}}],['private-network','ros_native_fetch',{req:{url:'https://127.0.0.1/'}}]
 ].map(async([name,cmd,args])=>{try{await invoke(cmd,args);return{name,denied:false};}catch(e){return{name,denied:true,code:e.code||'IPC_ACL_DENIED'};}})).then(results=>console.info('ANDROID_ROOT_BOUNDARIES',JSON.stringify(results)));

 const saveAnchor=async a=>{if(!a.download||!a.href.startsWith('blob:'))return false;const captured=downloadBlobs.get(a.href),b=captured||await(await originalFetch(a.href)).blob();if(b.size>16*1024*1024)throw new Error('Export exceeds 16 MiB');const bytes=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));await invoke('android_save_export',{name:a.download,mime:b.type||'application/octet-stream',base64:btoa(s)});return true;};
 const click=HTMLAnchorElement.prototype.click;
 HTMLAnchorElement.prototype.click=function(){if(this.download&&this.href.startsWith('blob:')){saveAnchor(this).catch(e=>alert(e.message||String(e)));}else click.call(this);};
 document.addEventListener('click',e=>{const a=e.target.closest?.('a[download]');if(a?.href.startsWith('blob:')){e.preventDefault();saveAnchor(a).catch(x=>alert(x.message||String(x)));}},true);
 window.addEventListener('DOMContentLoaded',async()=>{const s=await invoke('android_runtime_status');window.__androidRuntime=Object.freeze(s);console.info('ANDROID_RUNTIME_ACTUAL',JSON.stringify({platform:s.platform,abi:s.abi,debug:s.debugPoc,uiRevision:s.capabilities.uiRevision,debugLocalUi:s.capabilities.debugLocalUi,offlineStagenetProtocolTest:s.capabilities?.offlineStagenetProtocolTest,offlineRegtest:s.capabilities?.offlineRegtest,mainnetReadOnlyTest:s.capabilities?.mainnetReadOnlyTest,userAgent:navigator.userAgent,width:innerWidth,custody:s.custody,coarsePointerActual:window.__ANDROID_ACTUAL_COARSE_POINTER__,desktopLayoutExperiment:window.__ANDROID_STAGENET_DEBUG__===true}));
 const d=document.createElement('details');d.style.cssText='position:fixed;right:8px;bottom:52px;z-index:2147483647;background:#141b20;color:#bcffcc;border:1px solid #bcffcc;padding:5px;font:12px monospace;max-width:430px';
 d.innerHTML='<summary>Android DEBUG · STAGENET ONLY</summary><div>Public password: ANDROID-STAGENET-TEST-ONLY<br>No real keys/funds. No signing or secret export.<br>Browser: separate clearnet Activity, no wallet bridge.<br>Tor / VPN / Gateway / Local AI: unavailable.<br>Scanner: resumable batches; public-network full sync NOT verified.</div>';if(window.__ANDROID_STAGENET_DEBUG__){const copy=document.createElement('button');copy.textContent='Copy PUBLIC stagenet restore fixture';copy.onclick=()=>navigator.clipboard.writeText('avidly chlorine gave yeti ramped certain hybrid comb governing amply hinder pamphlet offend geometry narrate unopened robot epoxy annoyed glide ingested ascend were austere unopened').then(()=>{copy.textContent='Public fixture copied';}).catch(()=>{copy.textContent='Clipboard unavailable';});d.append(copy);} if(s.capabilities.debugLocalUi){const provenance=document.createElement('div');provenance.textContent='DEBUG source UI '+s.capabilities.uiRevision.slice(0,12)+(s.capabilities?.mainnetReadOnlyTest?' · MAINNET READ-ONLY THROWAWAY':s.capabilities?.offlineRegtest?' · FAKECHAIN REGTEST, NOT STAGENET':s.capabilities?.offlineStagenetProtocolTest?' · OFFLINE STAGENET PROTOCOL TEST':'');d.append(provenance);} document.body.append(d);
 if(window.__ANDROID_STAGENET_DEBUG__){const frame=document.createElement('iframe');frame.hidden=true;const denied=e=>{if(e.effectiveDirective==='frame-src'){console.info('ANDROID_IFRAME_DENIED',JSON.stringify({blocked:true,directive:e.effectiveDirective}));document.removeEventListener('securitypolicyviolation',denied);}};document.addEventListener('securitypolicyviolation',denied);frame.src='https://example.com/android-iframe-boundary-test';document.body.append(frame);setTimeout(()=>{frame.remove();document.removeEventListener('securitypolicyviolation',denied);},3000);}

 if(window.__ANDROID_STAGENET_DEBUG__){let previous='';const update=async()=>{if(document.hidden)return;try{const s=await invoke('get_sync_status');const label=(s.fixtureNetwork?.startsWith('FAKECHAIN')?'FAKECHAIN REGTEST · ':'')+(s.locked?'native wallet LOCKED':s.lastError?'scan unavailable: '+s.lastError:s.scanning?'resumable native scan in progress':'native '+(s.fixtureNetwork?.startsWith('MAINNET')?'mainnet read-only':'stagenet')+' · full sync NOT verified');const summary=d.querySelector('summary');summary.textContent=(s.fixtureNetwork?.startsWith('FAKECHAIN')?'Android DEBUG FAKECHAIN (NOT STAGENET) · ':s.fixtureNetwork?.startsWith('MAINNET')?'Android DEBUG MAINNET READ-ONLY · ':'Android DEBUG STAGENET · ')+label;if(label!==previous){console.info('ANDROID_WALLET_STATUS',JSON.stringify({locked:s.locked,scanning:s.scanning,lastError:s.lastError,fullSyncVerified:s.fullSyncVerified,scanHeight:s.scanHeight,ownedOutputCount:s.ownedOutputCount}));previous=label;}}catch{}};update();setInterval(update,4000);}
 });
}
