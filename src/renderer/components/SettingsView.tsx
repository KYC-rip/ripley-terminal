import React, { useState, useEffect } from 'react';
import { Settings, Server, Zap, EyeOff, Check, RefreshCw, History, ShieldAlert, Edit2, Download, FolderOpen, ExternalLink, Info, Loader2 } from 'lucide-react';
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

  // 📦 App Info & Updates state
  const [appInfo, setAppInfo] = useState<{ version: string; appDataPath: string; walletsPath: string; platform: string } | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [updateResult, setUpdateResult] = useState<{
    checked: boolean;
    hasUpdate?: boolean;
    latestVersion?: string;
    releaseUrl?: string;
    body?: string;
    error?: string;
  }>({ checked: false });
  const [showChangelog, setShowChangelog] = useState(false);

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

      const info = await window.api.getAppInfo();
      setAppInfo(info as any);
    };
    loadInitialConfig();
  }, [currentIdentity]);

  // --- Update Checker ---
  const handleCheckUpdate = async () => {
    setIsCheckingUpdate(true);
    setUpdateResult({ checked: false });
    setShowChangelog(false);
    try {
      const res = await window.api.checkForUpdates();
      if (res.success) {
        setUpdateResult({
          checked: true,
          hasUpdate: res.hasUpdate,
          latestVersion: res.latestVersion,
          releaseUrl: res.releaseUrl,
          body: res.body
        });
      } else {
        setUpdateResult({ checked: true, error: res.error });
      }
    } catch (e: any) {
      setUpdateResult({ checked: true, error: e.message });
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const handleReveal = async (path: string) => {
    const res = await window.api.openPath(path);
    if (!res.success) alert(`Failed to open path: ${res.error}`);
  };

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
          <p className="text-xs text-xmr-dim uppercase tracking-widest">Adjust tactical parameters and cryptographic routing.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 font-black">
        {/* 🆔 Identity Section */}
        <section className="space-y-4">
          <h3 className="text-xs font-black text-xmr-green flex items-center gap-2 uppercase"><Edit2 size={14} /> Identity_Management</h3>
          <Card className="p-6 bg-xmr-surface border-xmr-border/40">
            <div className="space-y-2">
              <label className="text-[11px] font-black text-xmr-dim uppercase">Active_Identity_Label</label>
              <input
                type="text"
                value={localSettings.identityName}
                onChange={(e) => setLocalSettings({ ...localSettings, identityName: e.target.value })}
                className="w-full bg-xmr-base border border-xmr-border p-3 text-xs text-xmr-green focus:border-xmr-green outline-none font-black"
              />
            </div>
          </Card>
        </section>

        {/* 📦 Version & Updates Section */}
        <section className="space-y-4">
          <h3 className="text-xs font-black text-xmr-green flex items-center gap-2 uppercase"><Download size={14} /> System_Updates</h3>
          <Card className="p-6 bg-xmr-surface border-xmr-border/40 space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <div className="text-xs font-black text-xmr-dim uppercase">Current_Version</div>
                <div className="text-xl text-xmr-green font-mono">v{appInfo?.version || '...'}</div>
              </div>
              <button
                onClick={handleCheckUpdate}
                disabled={isCheckingUpdate}
                className="px-4 py-2 border border-xmr-green text-xmr-green text-xs uppercase font-black tracking-widest hover:bg-xmr-green hover:text-xmr-base transition-colors flex items-center gap-2 cursor-pointer disabled:opacity-50"
              >
                {isCheckingUpdate ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                {isCheckingUpdate ? 'Checking...' : 'Check_For_Updates'}
              </button>
            </div>

            {updateResult.checked && (
              <div className={`mt-4 p-4 border rounded-sm text-xs ${updateResult.error ? 'border-red-500/50 bg-red-500/10 text-red-400' : updateResult.hasUpdate ? 'border-xmr-accent/50 bg-xmr-accent/10 text-xmr-accent' : 'border-xmr-border bg-xmr-base text-xmr-dim'}`}>
                {updateResult.error ? (
                  <div className="flex items-center gap-2"><ShieldAlert size={14} /> Update check failed: {updateResult.error}</div>
                ) : updateResult.hasUpdate ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-black uppercase text-xs">
                        <Zap size={14} className="animate-pulse" /> Update Available: v{updateResult.latestVersion}
                      </div>
                      <button onClick={() => updateResult.releaseUrl && window.open(updateResult.releaseUrl)} className="flex items-center gap-1.5 px-3 py-1.5 bg-xmr-accent text-xmr-base hover:bg-white transition-colors cursor-pointer font-black uppercase">
                        <Download size={10} /> Download Release
                      </button>
                    </div>
                    {updateResult.body && (
                      <div className="mt-2 text-xmr-green border border-xmr-border/50 bg-xmr-base">
                        <button onClick={() => setShowChangelog(!showChangelog)} className="w-full flex items-center justify-between p-2 hover:bg-xmr-surface transition-colors cursor-pointer text-[11px] uppercase tracking-widest text-xmr-dim">
                          <span>View Changelog</span>
                          <span className="opacity-50 text-[16px] leading-none">{showChangelog ? '−' : '+'}</span>
                        </button>
                        {showChangelog && (
                          <div className="p-3 border-t border-xmr-border/50 font-mono whitespace-pre-wrap max-h-48 overflow-y-auto custom-scrollbar text-[11px]">
                            {updateResult.body}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 uppercase font-black"><Check size={14} className="text-xmr-green" /> System is up to date</div>
                )}
              </div>
            )}
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
                  <span className="text-xs text-xmr-green font-black uppercase">Tor_Darknet_Routing</span>
                </div>
                <p className="text-xs text-xmr-dim uppercase font-black">Onion_Tunnel_Privacy_Active</p>
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
                  <span className={`text-xs font-black uppercase ${localSettings.network === 'stagenet' ? 'text-orange-500' : ''}`}>Stagenet_Protocol</span>
                </div>
                <p className="text-xs text-xmr-dim uppercase font-black">Sandbox_Test_Network</p>
              </div>
              <button
                onClick={() => setLocalSettings({ ...localSettings, network: localSettings.network === 'stagenet' ? 'mainnet' : 'stagenet' })}
                className={`w-10 h-5 rounded-full relative transition-all cursor-pointer ${localSettings.network === 'stagenet' ? 'bg-xmr-accent' : 'bg-xmr-base border border-xmr-border'}`}
              >
                <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${localSettings.network === 'stagenet' ? 'right-1 bg-xmr-base' : 'left-1 bg-xmr-border'}`}></div>
              </button>
            </div>

            {/* System Proxy */}
            <div className="flex items-center justify-between p-4 bg-xmr-green/5 border border-xmr-green/20 rounded-sm">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-xmr-green font-black uppercase">Follow_OS_Proxy</span>
                </div>
                <p className="text-xs text-xmr-dim uppercase font-black">Inherit_System_Network_Settings</p>
              </div>
              <button
                onClick={() => setLocalSettings({ ...localSettings, useSystemProxy: !localSettings.useSystemProxy })}
                className={`w-10 h-5 rounded-full relative transition-all cursor-pointer ${localSettings.useSystemProxy ? 'bg-xmr-green' : 'bg-xmr-base border border-xmr-border'}`}
              >
                <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${localSettings.useSystemProxy ? 'right-1 bg-xmr-base' : 'left-1 bg-xmr-border'}`}></div>
              </button>
            </div>

            {!localSettings.useSystemProxy && (
              <div className="space-y-2 mt-2">
                <label className="text-[11px] font-black text-xmr-dim uppercase border-l-2 border-xmr-border pl-2">Manual_Proxy_Override (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g., socks5://127.0.0.1:7890"
                  value={localSettings.systemProxyAddress}
                  onChange={(e) => setLocalSettings({ ...localSettings, systemProxyAddress: e.target.value })}
                  className="w-full bg-xmr-base border border-xmr-border focus:border-xmr-green/50 hover:border-xmr-green/30 p-3 text-xs text-xmr-green outline-none font-black transition-colors"
                />
              </div>
            )}

            {/* Custom Node Address */}
            <div className="space-y-2">
              <label className="text-[11px] font-black text-xmr-dim uppercase">Manual_Uplink_Address (Optional)</label>
              <input
                type="text"
                placeholder="Leave empty for automatic node selection"
                value={localSettings.customNodeAddress}
                onChange={(e) => setLocalSettings({ ...localSettings, customNodeAddress: e.target.value })}
                className="w-full bg-xmr-base border border-xmr-border p-3 text-xs text-xmr-green focus:border-xmr-green outline-none font-black"
              />
            </div>
          </Card>
        </section>

        {/* 📊 Rescan Section */}
        <section className="space-y-4">
          <h3 className="text-xs font-black text-xmr-green flex items-center gap-2 uppercase"><History size={14} /> Synchronized_Ledger</h3>
          <Card className="p-6 bg-xmr-surface border-xmr-border/40 space-y-4">
            <div className="flex justify-between items-center text-xs font-black uppercase">
              <span className="text-xmr-dim">Current_Head</span>
              <span className="text-xmr-green">{currentHeight || 'FETCHING...'}</span>
            </div>
            <div className="space-y-2">
              <label className="text-[11px] font-black text-xmr-dim uppercase">Target_Restore_Height</label>
              <div className="flex gap-2">
                <input
                  type="number"
                  placeholder="3100000"
                  value={targetHeight}
                  onChange={(e) => setTargetHeight(e.target.value)}
                  className="flex-grow bg-xmr-base border border-xmr-border p-3 text-xs text-xmr-green focus:border-xmr-green outline-none font-black"
                />
                <button
                  disabled={isRescanning || !targetHeight}
                  onClick={handleRescan}
                  className="px-4 bg-xmr-green text-xmr-base text-xs font-black uppercase hover:bg-white transition-all disabled:opacity-50 cursor-pointer"
                >
                  {isRescanning ? 'Scanning...' : 'Trigger_Rescan'}
                </button>
              </div>
            </div>
          </Card>
        </section>

        {/* 📁 Storage Paths Section */}
        <section className="space-y-4">
          <h3 className="text-xs font-black text-xmr-green flex items-center gap-2 uppercase"><FolderOpen size={14} /> Data_Storage</h3>
          <Card className="p-6 bg-xmr-surface border-xmr-border/40 space-y-4">
            <div className="space-y-4">
              {/* App Data Path */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-black text-xmr-dim uppercase">
                  <span>Application_Data</span>
                  <button onClick={() => appInfo?.appDataPath && handleReveal(appInfo.appDataPath)} className="flex items-center gap-1 hover:text-xmr-accent transition-colors cursor-pointer"><ExternalLink size={10} /> Reveal</button>
                </div>
                <div className="w-full bg-xmr-base border border-xmr-border p-2 text-[11px] text-xmr-green opacity-70 font-mono select-all overflow-x-auto whitespace-nowrap custom-scrollbar">
                  {appInfo?.appDataPath || 'Loading...'}
                </div>
                <p className="text-xs text-xmr-dim uppercase opacity-60">Contains configuration, node lists, and Tor runtime data.</p>
              </div>

              {/* Wallets Path */}
              <div className="space-y-1.5 pt-2 border-t border-xmr-border/20">
                <div className="flex items-center justify-between text-xs font-black text-xmr-dim uppercase">
                  <span>Encrypted_Vault_Storage</span>
                  <button onClick={() => appInfo?.walletsPath && handleReveal(appInfo.walletsPath)} className="flex items-center gap-1 hover:text-xmr-accent transition-colors cursor-pointer"><ExternalLink size={10} /> Reveal</button>
                </div>
                <div className="w-full bg-xmr-base border border-red-900/30 p-2 text-[11px] text-xmr-green opacity-70 font-mono select-all overflow-x-auto whitespace-nowrap custom-scrollbar">
                  {appInfo?.walletsPath || 'Loading...'}
                </div>
                <p className="text-xs text-red-500/60 uppercase font-black flex items-center gap-1"><ShieldAlert size={8} /> Never share or modify these files manually. Backup regularly.</p>
              </div>
            </div>
          </Card>
        </section>

        {/* 👁️ Visuals & UI Section */}
        <section className="space-y-4">
          <h3 className="text-xs font-black text-xmr-green flex items-center gap-2 uppercase"><EyeOff size={14} /> Countermeasures & UI</h3>
          <Card className="p-6 bg-xmr-surface border-xmr-border/40 space-y-6">
            <div className="flex items-center justify-between">
              <div className="space-y-1"><span className="text-xs text-xmr-green font-black uppercase">CRT_Visual_Scanlines</span><p className="text-xs text-xmr-dim uppercase font-black">Overlay_Effect</p></div>
              <button
                onClick={() => setLocalSettings({ ...localSettings, show_scanlines: !localSettings.show_scanlines })}
                className={`w-10 h-5 rounded-full relative transition-all cursor-pointer ${localSettings.show_scanlines ? 'bg-xmr-green' : 'bg-xmr-base border border-xmr-border'}`}
              >
                <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${localSettings.show_scanlines ? 'right-1 bg-xmr-base' : 'left-1 bg-xmr-border'}`}></div>
              </button>
            </div>

            <div className="flex items-center justify-between border-t border-xmr-border/10 pt-6">
              <div className="space-y-1">
                <span className="text-xs text-xmr-green font-black uppercase">Auto_Lock_Timeout</span>
                <p className="text-xs text-xmr-dim uppercase font-black">Lock session after inactivity (min)</p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={localSettings.auto_lock_minutes}
                  onChange={(e) => setLocalSettings({ ...localSettings, auto_lock_minutes: parseInt(e.target.value) || 0 })}
                  className="w-20 bg-xmr-base border border-xmr-border p-2 text-right text-xs text-xmr-green outline-none font-black"
                />
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-xmr-border/10 pt-6">
              <div className="space-y-1">
                <span className="text-xs text-xmr-green font-black uppercase">Reset_Context_Tooltips</span>
                <p className="text-xs text-xmr-dim uppercase font-black">Restore all dismissed 'How It Works' banners</p>
              </div>
              <button
                onClick={() => {
                  localStorage.removeItem('hide_explainer_vault_churn');
                  localStorage.removeItem('hide_explainer_vault_splinter');
                  alert("CONTEXT_RESET: Educational banners will reappear.");
                }}
                className="px-3 py-1.5 border border-xmr-border text-[10px] uppercase font-black hover:border-xmr-green hover:text-xmr-green transition-all cursor-pointer"
              >
                Restore_Banners
              </button>
            </div>
          </Card>
        </section>

        {/* ☢️ Danger Zone */}
        <section className="space-y-4 pt-4">
          <h3 className="text-xs font-black text-red-500 flex items-center gap-2 uppercase"><ShieldAlert size={14} /> Dangerous_Sector</h3>
          <Card className="p-6 bg-red-950/10 border-red-900/30 flex items-center justify-between">
            <div className="space-y-1"><span className="text-xs font-black text-red-500 uppercase">Nuclear_Burn_ID</span><p className="text-xs text-red-500/60 uppercase font-black">Erase local seed and vault keys forever.</p></div>
            <button onClick={() => purgeIdentity(activeId)} className="px-4 py-2 border border-red-600 text-red-500 text-xs font-black hover:bg-red-600 hover:text-white transition-all uppercase cursor-pointer">Burn_Everything</button>
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