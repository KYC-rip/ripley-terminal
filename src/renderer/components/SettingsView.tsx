import React, { useState, useEffect } from 'react';
import { Settings, Server, Zap, EyeOff, Check, RefreshCw, History } from 'lucide-react';
import { Card } from './Card';
import { useTor } from '../contexts/TorContext';
import { useVault } from '../hooks/useVault';

export function SettingsView() {
  const { useTor: torEnabled, setUseTor } = useTor();
  const { rescan, currentHeight } = useVault();
  const [daemonUrl, setDaemonUrl] = useState('');
  const [isAutoNode, setIsAutoNode] = useState(true);
  const [isStagenet, setIsStagenet] = useState(false);
  const [showScanlines, setShowScanlines] = useState(true);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  
  // Rescan State
  const [targetHeight, setTargetHeight] = useState<string>('');
  const [isRescanning, setIsRescaning] = useState(false);

  useEffect(() => {
    const configPrefix = isStagenet ? 'stagenet' : 'mainnet';
    (window as any).api.getConfig(`custom_daemon_${configPrefix}`).then((v: string) => setDaemonUrl(v || ''));
    (window as any).api.getConfig(`auto_node_${configPrefix}`).then((v: boolean) => setIsAutoNode(v !== false));
    (window as any).api.getConfig('is_stagenet').then((v: boolean) => setIsStagenet(!!v));
    (window as any).api.getConfig('show_scanlines').then((v: boolean) => {
      if (v !== undefined) setShowScanlines(v);
    });
  }, [isStagenet]);

  const handleSave = async () => {
    setSaveStatus('saving');
    
    const oldStagenet = await (window as any).api.getConfig('is_stagenet');
    const networkChanged = !!oldStagenet !== isStagenet;
    const configPrefix = isStagenet ? 'stagenet' : 'mainnet';

    await (window as any).api.setConfig(`custom_daemon_${configPrefix}`, daemonUrl);
    await (window as any).api.setConfig(`auto_node_${configPrefix}`, isAutoNode);
    await (window as any).api.setConfig('is_stagenet', isStagenet);
    await (window as any).api.setConfig('show_scanlines', showScanlines);
    
    setUseTor(torEnabled);

    setSaveStatus('saved');
    setTimeout(() => setSaveStatus('idle'), 2000);
    
    if (networkChanged) {
      if (confirm("NETWORK_PROTOCOL_CHANGED. Terminal must reboot to re-initialize WASM engine. Continue?")) {
        location.reload();
      }
    }
  };

  const handleRescan = async () => {
    const h = parseInt(targetHeight);
    if (isNaN(h)) {
      alert("INVALID_HEIGHT");
      return;
    }
    if (confirm(`INITIATE_RESCAN from height ${h}? This will clear local cache and re-scan the blockchain.`)) {
      setIsRescaning(true);
      try {
        await rescan(h);
        alert("RESCAN_SIGNAL_BROADCASTED.");
      } catch (e: any) {
        alert(`RESCAN_FAILED: ${e.message}`);
      } finally {
        setIsRescaning(false);
      }
    }
  };

  return (
    <div className="max-w-3xl mx-auto py-8 space-y-8 animate-in fade-in slide-in-from-right-4 duration-500 font-mono font-black">
      <div className="flex items-center gap-4 border-b border-xmr-border/30 pb-6">
        <Settings size={32} className="text-xmr-green" />
        <div>
          <h2 className="text-3xl font-black italic uppercase tracking-tighter text-xmr-green font-black">Terminal_Config</h2>
          <p className="text-[10px] text-xmr-dim uppercase tracking-widest">Adjust tactical parameters and cryptographic routing.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 font-black">
        <section className="space-y-4 font-black">
          <h3 className="text-xs font-black text-xmr-green flex items-center gap-2 uppercase font-black"><Server size={14} /> Uplink_Protocols</h3>
          <Card className="p-6 bg-xmr-surface border-xmr-border/40 space-y-6">
            
            <div className="flex items-center justify-between p-4 bg-xmr-green/5 border border-xmr-green/20 rounded-sm">
              <div className="space-y-1">
                <span className="text-[10px] text-xmr-green font-black uppercase">Automatic_Node_Switching</span>
                <p className="text-[8px] text-xmr-dim uppercase font-black tracking-tighter">Radar_Optimization_Active</p>
              </div>
              <button 
                onClick={() => setIsAutoNode(!isAutoNode)}
                className={`w-10 h-5 rounded-full relative transition-all cursor-pointer ${isAutoNode ? 'bg-xmr-green' : 'bg-xmr-base border border-xmr-border'}`}
              >
                <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${isAutoNode ? 'right-1 bg-xmr-base' : 'left-1 bg-xmr-border'}`}></div>
              </button>
            </div>

            {!isAutoNode && (
              <div className="space-y-2 animate-in slide-in-from-top-2 duration-300">
                <label className="text-[9px] font-black text-xmr-dim uppercase">Manual_Uplink_Address (RPC_URL)</label>
                <input 
                  type="text" 
                  placeholder="https://your-private-node.com:18081"
                  value={daemonUrl}
                  onChange={(e) => setDaemonUrl(e.target.value)}
                  className="w-full bg-xmr-base border border-xmr-border p-3 text-[10px] text-xmr-green focus:border-xmr-green outline-none font-black"
                />
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex items-center justify-between p-4 bg-xmr-green/5 border border-xmr-green/20 rounded-sm">
                <div className="space-y-1">
                  <div className="flex items-center gap-2"><Zap size={14} className={torEnabled ? "text-xmr-green animate-pulse" : "text-xmr-dim"} /><span className="text-[10px] text-xmr-green font-black uppercase">Tor_Routing</span></div>
                  <p className="text-[8px] text-xmr-dim uppercase font-black">Darknet_Tunnel</p>
                </div>
                <button onClick={() => setUseTor(!torEnabled)} className={`w-10 h-5 rounded-full relative transition-all cursor-pointer ${torEnabled ? 'bg-xmr-green' : 'bg-xmr-base border border-xmr-border'}`}><div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${torEnabled ? 'right-1 bg-xmr-base' : 'left-1 bg-xmr-border'}`}></div></button>
              </div>

              <div className={`flex items-center justify-between p-4 border rounded-sm transition-all ${isStagenet ? 'bg-xmr-accent/10 border-xmr-accent/40' : 'bg-xmr-green/5 border-xmr-border opacity-60'}`}>
                <div className="space-y-1">
                  <div className="flex items-center gap-2"><RefreshCw size={14} className={isStagenet ? "text-orange-500 animate-spin" : "text-xmr-dim"} /><span className={`text-[10px] font-black uppercase ${isStagenet ? 'text-orange-500' : ''}`}>Stagenet_Mode</span></div>
                  <p className="text-[8px] text-xmr-dim uppercase font-black">Testing_Assets</p>
                </div>
                <button onClick={() => setIsStagenet(!isStagenet)} className={`w-10 h-5 rounded-full relative transition-all cursor-pointer ${isStagenet ? 'bg-xmr-accent' : 'bg-xmr-base border border-xmr-border'}`}><div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${isStagenet ? 'right-1 bg-xmr-base' : 'left-1 bg-xmr-border'}`}></div></button>
              </div>
            </div>
          </Card>
        </section>

        <section className="space-y-4">
          <h3 className="text-xs font-black text-xmr-green flex items-center gap-2 uppercase font-black"><History size={14} /> Synchronized_Ledger</h3>
          <Card className="p-6 bg-xmr-surface border-xmr-border/40 space-y-4">
             <div className="flex justify-between items-center text-[10px] font-black uppercase">
                <span className="text-xmr-dim">Current_Head</span>
                <span className="text-xmr-green">{currentHeight || 'WAITING...'}</span>
             </div>
             <div className="space-y-2">
                <label className="text-[9px] font-black text-xmr-dim uppercase">Target_Restore_Height</label>
                <div className="flex gap-2">
                   <input 
                     type="number" 
                     placeholder="3000000"
                     value={targetHeight}
                     onChange={(e) => setTargetHeight(e.target.value)}
                     className="flex-grow bg-xmr-base border border-xmr-border p-3 text-[10px] text-xmr-green focus:border-xmr-green outline-none font-black"
                   />
                   <button 
                     disabled={isRescanning || !targetHeight}
                     onClick={handleRescan}
                     className="px-4 bg-xmr-green text-xmr-base text-[10px] font-black uppercase hover:bg-white transition-all disabled:opacity-50"
                   >
                     {isRescanning ? 'Scanning...' : 'Trigger_Rescan'}
                   </button>
                </div>
                <p className="text-[7px] text-xmr-dim uppercase italic">Caution: Rescanning will clear local TX history and re-parse blockchain from the specified height.</p>
             </div>
          </Card>
        </section>

        <section className="space-y-4">
          <h3 className="text-xs font-black text-xmr-green flex items-center gap-2 uppercase font-black"><EyeOff size={14} /> Countermeasures</h3>
          <Card className="p-6 bg-xmr-surface border-xmr-border/40 flex items-center justify-between">
            <div className="space-y-1"><span className="text-[10px] text-xmr-green font-black uppercase">Visual_Scanlines</span><p className="text-[8px] text-xmr-dim uppercase font-black">CRT_Effect_Overlay</p></div>
            <button onClick={() => setShowScanlines(!showScanlines)} className={`w-10 h-5 rounded-full relative transition-all cursor-pointer ${showScanlines ? 'bg-xmr-green' : 'bg-xmr-base border border-xmr-border'}`}><div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${showScanlines ? 'right-1 bg-xmr-base' : 'left-1 bg-xmr-border'}`}></div></button>
          </Card>
        </section>

        <section className="space-y-4 pt-4">
          <h3 className="text-xs font-black text-red-500 flex items-center gap-2 uppercase font-black">Dangerous_Sector</h3>
          <Card className="p-6 bg-red-950/10 border-red-900/30 flex items-center justify-between">
            <div className="space-y-1"><span className="text-[10px] font-black text-red-500 uppercase">Nuclear_Burn_ID</span><p className="text-[8px] text-red-500/60 uppercase font-black max-w-[200px]">Irreversibly erase local master seed.</p></div>
            <button onClick={async () => { if(confirm("BURN_IDENTITY? This action cannot be undone.")) { await (window as any).api.burnIdentity(); location.reload(); } }} className="px-4 py-2 border border-red-600 text-red-500 text-[10px] font-black hover:bg-red-600 hover:text-white transition-all uppercase font-black cursor-pointer">Exterminate_ID</button>
          </Card>
        </section>
      </div>

      <div className="pt-6 flex justify-end font-black">
        <button onClick={handleSave} disabled={saveStatus !== 'idle'} className={`px-10 py-4 font-black uppercase tracking-[0.3em] flex items-center gap-3 transition-all cursor-pointer ${saveStatus === 'saved' ? 'bg-xmr-green text-xmr-base' : 'bg-xmr-green text-xmr-base hover:opacity-90 font-black'}`}>
          {saveStatus === 'saving' ? <RefreshCw size={16} className="animate-spin" /> : saveStatus === 'saved' ? <Check size={16} /> : null}
          {saveStatus === 'saving' ? 'Applying...' : saveStatus === 'saved' ? 'Config_Applied' : 'Save_Configurations'}
        </button>
      </div>
    </div>
  );
}
