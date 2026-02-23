import React, { useState, useEffect } from 'react';
import { Settings, Server, Zap, EyeOff, Check, RefreshCw, History, ShieldAlert, Edit2 } from 'lucide-react';
import { Card } from './Card';
import { useVault } from '../hooks/useVault';

export function SettingsView() {
  const { rescan, currentHeight, purgeIdentity, activeId, renameIdentity, identities } = useVault();

  // 🟢 Unified configuration state
  const [config, setConfig] = useState<any>(null);

  // Local UI state (for interaction before saving)
  const [localSettings, setLocalSettings] = useState({
    routingMode: 'tor',
    network: 'mainnet',
    customNodeAddress: '',
    show_scanlines: true,
    auto_lock_minutes: 10,
    identityName: '',
    useSystemProxy: false,
    systemProxyAddress: ''
  });

  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [targetHeight, setTargetHeight] = useState<string>('');
  const [isRescanning, setIsRescaning] = useState(false);

  const currentIdentity = identities.find(i => i.id === activeId);

  // 1. Initialization: Load full configuration
  useEffect(() => {
    const loadInitialConfig = async () => {
      const fullConfig = await window.api.getConfig();
      setConfig(fullConfig);
      setLocalSettings({
        routingMode: fullConfig.routingMode || 'tor',
        network: fullConfig.network || 'mainnet',
        customNodeAddress: fullConfig.customNodeAddress || '',
        show_scanlines: fullConfig.show_scanlines !== false,
        auto_lock_minutes: fullConfig.auto_lock_minutes || 10,
        identityName: currentIdentity?.name || '',
        useSystemProxy: fullConfig.useSystemProxy || false,
        systemProxyAddress: fullConfig.systemProxyAddress || ''
      });
    };
    loadInitialConfig();
  }, [currentIdentity]);

  // 2. Save: One-time submission to backend
  const handleSave = async () => {
    setSaveStatus('saving');

    try {
      // 1. Handle identity renaming (logical change, no effect on engine)
      if (localSettings.identityName && localSettings.identityName !== currentIdentity?.name) {
        await renameIdentity(activeId, localSettings.identityName);
      }

      // 2. Check if a "physical change" was triggered
      const needsPhysicalReload =
        localSettings.routingMode !== config.routingMode ||
        localSettings.network !== config.network ||
        localSettings.customNodeAddress !== config.customNodeAddress ||
        localSettings.useSystemProxy !== config.useSystemProxy ||
        localSettings.systemProxyAddress !== config.systemProxyAddress;

      const newConfig = {
        ...config,
        routingMode: localSettings.routingMode,
        network: localSettings.network,
        customNodeAddress: localSettings.customNodeAddress,
        useSystemProxy: localSettings.useSystemProxy,
        systemProxyAddress: localSettings.systemProxyAddress,
        show_scanlines: localSettings.show_scanlines,
        auto_lock_minutes: localSettings.auto_lock_minutes
      };

      if (needsPhysicalReload) {
        // 🚀 Trigger physical reload: Reboot Tor / RPC processes
        console.log("⚙️ Physical parameters changed. Re-igniting Uplink...", "warning");
        const res = await window.api.saveConfigAndReload(newConfig);
        if (!res.success) throw new Error(res.error);
      } else {
        // 💾 Save config only: no interruption to current connection
        console.log("💾 UI preferences synchronized.", "success");
        // note: if backend lacks saveConfigOnly, reloadEngine can skip reboot based on logic checks
        await window.api.saveConfigOnly?.(newConfig) || await window.api.saveConfigAndReload(newConfig);
      }

      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);

      // Update local benchmark to prevent miscalculation next time
      setConfig(newConfig);

    } catch (e: any) {
      alert(`SAVE_FAILED: ${e.message}`);
      setSaveStatus('idle');
    }
  };

  const handleRescan = async () => {
    const h = parseInt(targetHeight);
    if (isNaN(h)) return alert("INVALID_HEIGHT");

    if (confirm(`INITIATE_RESCAN from height ${h}? This will clear local wallet cache.`)) {
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

  if (!config) return null; // Loading

  return (
    <div className="max-w-3xl mx-auto py-8 space-y-8 animate-in fade-in slide-in-from-right-4 duration-500 font-mono font-black">
      <div className="flex items-center gap-4 border-b border-xmr-border/30 pb-6">
        <Settings size={32} className="text-xmr-green" />
        <div>
          <h2 className="text-3xl font-black italic uppercase tracking-tighter text-xmr-green">Terminal_Config</h2>
          <p className="text-[10px] text-xmr-dim uppercase tracking-widest">Adjust tactical parameters and cryptographic routing.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 font-black">
        {/* 🆔 Identity Section */}
        <section className="space-y-4">
          <h3 className="text-xs font-black text-xmr-green flex items-center gap-2 uppercase"><Edit2 size={14} /> Identity_Management</h3>
          <Card className="p-6 bg-xmr-surface border-xmr-border/40">
            <div className="space-y-2">
              <label className="text-[9px] font-black text-xmr-dim uppercase">Active_Identity_Label</label>
              <input
                type="text"
                value={localSettings.identityName}
                onChange={(e) => setLocalSettings({ ...localSettings, identityName: e.target.value })}
                className="w-full bg-xmr-base border border-xmr-border p-3 text-[10px] text-xmr-green focus:border-xmr-green outline-none font-black"
              />
            </div>
          </Card>
        </section>

        {/* 🌐 Network Section */}
        <section className="space-y-4 font-black">
          <h3 className="text-xs font-black text-xmr-green flex items-center gap-2 uppercase"><Server size={14} /> Uplink_Protocols</h3>
          <Card className="p-6 bg-xmr-surface border-xmr-border/40 space-y-6">

            {/* Routing Mode Toggle (Tor vs Clearnet) */}
            <div className="flex items-center justify-between p-4 bg-xmr-green/5 border border-xmr-green/20 rounded-sm">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Zap size={14} className={localSettings.routingMode === 'tor' ? "text-xmr-green animate-pulse" : "text-xmr-dim"} />
                  <span className="text-[10px] text-xmr-green font-black uppercase">Tor_Darknet_Routing</span>
                </div>
                <p className="text-[8px] text-xmr-dim uppercase font-black">Onion_Tunnel_Privacy_Active</p>
              </div>
              <button
                onClick={() => setLocalSettings({ ...localSettings, routingMode: localSettings.routingMode === 'tor' ? 'clearnet' : 'tor' })}
                className={`w-10 h-5 rounded-full relative transition-all cursor-pointer ${localSettings.routingMode === 'tor' ? 'bg-xmr-green' : 'bg-xmr-base border border-xmr-border'}`}
              >
                <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${localSettings.routingMode === 'tor' ? 'right-1 bg-xmr-base' : 'left-1 bg-xmr-border'}`}></div>
              </button>
            </div>

            {/* Network Toggle (Mainnet vs Stagenet) */}
            <div className={`flex items-center justify-between p-4 border rounded-sm transition-all ${localSettings.network === 'stagenet' ? 'bg-xmr-accent/10 border-xmr-accent/40' : 'bg-xmr-green/5 border-xmr-border opacity-60'}`}>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <RefreshCw size={14} className={localSettings.network === 'stagenet' ? "text-orange-500 animate-spin" : "text-xmr-dim"} />
                  <span className={`text-[10px] font-black uppercase ${localSettings.network === 'stagenet' ? 'text-orange-500' : ''}`}>Stagenet_Protocol</span>
                </div>
                <p className="text-[8px] text-xmr-dim uppercase font-black">Sandbox_Test_Network</p>
              </div>
              <button
                onClick={() => setLocalSettings({ ...localSettings, network: localSettings.network === 'stagenet' ? 'mainnet' : 'stagenet' })}
                className={`w-10 h-5 rounded-full relative transition-all cursor-pointer ${localSettings.network === 'stagenet' ? 'bg-xmr-accent' : 'bg-xmr-base border border-xmr-border'}`}
              >
                <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${localSettings.network === 'stagenet' ? 'right-1 bg-xmr-base' : 'left-1 bg-xmr-border'}`}></div>
              </button>
            </div>

            {/* Custom Front Proxy */}
            <div className="flex items-center justify-between p-4 bg-xmr-green/5 border border-xmr-green/20 rounded-sm">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-xmr-green font-black uppercase">Frontend_Proxy</span>
                </div>
                <p className="text-[8px] text-xmr-dim uppercase font-black">Route_Through_Local_Proxy (e.g., Clash)</p>
              </div>
              <button
                onClick={() => setLocalSettings({ ...localSettings, useSystemProxy: !localSettings.useSystemProxy })}
                className={`w-10 h-5 rounded-full relative transition-all cursor-pointer ${localSettings.useSystemProxy ? 'bg-xmr-green' : 'bg-xmr-base border border-xmr-border'}`}
              >
                <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${localSettings.useSystemProxy ? 'right-1 bg-xmr-base' : 'left-1 bg-xmr-border'}`}></div>
              </button>
            </div>

            {localSettings.useSystemProxy && (
              <div className="space-y-2 mt-2">
                <label className="text-[9px] font-black text-xmr-green uppercase">Proxy_Address</label>
                <input
                  type="text"
                  placeholder="e.g., socks5://127.0.0.1:7890"
                  value={localSettings.systemProxyAddress}
                  onChange={(e) => setLocalSettings({ ...localSettings, systemProxyAddress: e.target.value })}
                  className="w-full bg-xmr-base border border-xmr-green/50 p-3 text-[10px] text-xmr-green focus:border-xmr-green outline-none font-black"
                />
              </div>
            )}

            {/* Custom Node Address */}
            <div className="space-y-2">
              <label className="text-[9px] font-black text-xmr-dim uppercase">Manual_Uplink_Address (Optional)</label>
              <input
                type="text"
                placeholder="Leave empty for automatic node selection"
                value={localSettings.customNodeAddress}
                onChange={(e) => setLocalSettings({ ...localSettings, customNodeAddress: e.target.value })}
                className="w-full bg-xmr-base border border-xmr-border p-3 text-[10px] text-xmr-green focus:border-xmr-green outline-none font-black"
              />
            </div>
          </Card>
        </section>

        {/* 📊 Rescan Section */}
        <section className="space-y-4">
          <h3 className="text-xs font-black text-xmr-green flex items-center gap-2 uppercase"><History size={14} /> Synchronized_Ledger</h3>
          <Card className="p-6 bg-xmr-surface border-xmr-border/40 space-y-4">
            <div className="flex justify-between items-center text-[10px] font-black uppercase">
              <span className="text-xmr-dim">Current_Head</span>
              <span className="text-xmr-green">{currentHeight || 'FETCHING...'}</span>
            </div>
            <div className="space-y-2">
              <label className="text-[9px] font-black text-xmr-dim uppercase">Target_Restore_Height</label>
              <div className="flex gap-2">
                <input
                  type="number"
                  placeholder="3100000"
                  value={targetHeight}
                  onChange={(e) => setTargetHeight(e.target.value)}
                  className="flex-grow bg-xmr-base border border-xmr-border p-3 text-[10px] text-xmr-green focus:border-xmr-green outline-none font-black"
                />
                <button
                  disabled={isRescanning || !targetHeight}
                  onClick={handleRescan}
                  className="px-4 bg-xmr-green text-xmr-base text-[10px] font-black uppercase hover:bg-white transition-all disabled:opacity-50 cursor-pointer"
                >
                  {isRescanning ? 'Scanning...' : 'Trigger_Rescan'}
                </button>
              </div>
            </div>
          </Card>
        </section>

        {/* 👁️ Visuals Section */}
        <section className="space-y-4">
          <h3 className="text-xs font-black text-xmr-green flex items-center gap-2 uppercase"><EyeOff size={14} /> Countermeasures</h3>
          <Card className="p-6 bg-xmr-surface border-xmr-border/40 space-y-6">
            <div className="flex items-center justify-between">
              <div className="space-y-1"><span className="text-[10px] text-xmr-green font-black uppercase">CRT_Visual_Scanlines</span><p className="text-[8px] text-xmr-dim uppercase font-black">Overlay_Effect</p></div>
              <button
                onClick={() => setLocalSettings({ ...localSettings, show_scanlines: !localSettings.show_scanlines })}
                className={`w-10 h-5 rounded-full relative transition-all cursor-pointer ${localSettings.show_scanlines ? 'bg-xmr-green' : 'bg-xmr-base border border-xmr-border'}`}
              >
                <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${localSettings.show_scanlines ? 'right-1 bg-xmr-base' : 'left-1 bg-xmr-border'}`}></div>
              </button>
            </div>

            <div className="flex items-center justify-between border-t border-xmr-border/10 pt-6">
              <div className="space-y-1">
                <span className="text-[10px] text-xmr-green font-black uppercase">Auto_Lock_Timeout</span>
                <p className="text-[8px] text-xmr-dim uppercase font-black">Lock session after inactivity (min)</p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={localSettings.auto_lock_minutes}
                  onChange={(e) => setLocalSettings({ ...localSettings, auto_lock_minutes: parseInt(e.target.value) || 0 })}
                  className="w-20 bg-xmr-base border border-xmr-border p-2 text-right text-[10px] text-xmr-green outline-none font-black"
                />
              </div>
            </div>
          </Card>
        </section>

        {/* ☢️ Danger Zone */}
        <section className="space-y-4 pt-4">
          <h3 className="text-xs font-black text-red-500 flex items-center gap-2 uppercase"><ShieldAlert size={14} /> Dangerous_Sector</h3>
          <Card className="p-6 bg-red-950/10 border-red-900/30 flex items-center justify-between">
            <div className="space-y-1"><span className="text-[10px] font-black text-red-500 uppercase">Nuclear_Burn_ID</span><p className="text-[8px] text-red-500/60 uppercase font-black">Erase local seed and vault keys forever.</p></div>
            <button onClick={() => purgeIdentity(activeId)} className="px-4 py-2 border border-red-600 text-red-500 text-[10px] font-black hover:bg-red-600 hover:text-white transition-all uppercase cursor-pointer">Burn_Everything</button>
          </Card>
        </section>
      </div>

      <div className="pt-6 flex justify-end">
        <button
          onClick={handleSave}
          disabled={saveStatus !== 'idle'}
          className="px-10 py-4 font-black uppercase tracking-[0.3em] flex items-center gap-3 transition-all cursor-pointer bg-xmr-green text-xmr-base hover:opacity-90"
        >
          {saveStatus === 'saving' ? <RefreshCw size={16} className="animate-spin" /> : saveStatus === 'saved' ? <Check size={16} /> : null}
          {saveStatus === 'saving' ? 'Applying_Uplink...' : saveStatus === 'saved' ? 'Config_Synchronized' : 'Commit_Changes'}
        </button>
      </div>
    </div>
  );
}