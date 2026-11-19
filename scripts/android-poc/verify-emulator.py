#!/usr/bin/env python3
"""Actual Android adb/UIAutomator smoke tests. Never uses a host browser.
Requires the disposable run.ripley.androidpoc DEBUG APK and an already-booted AVD.
Only app-private test reports (no seed/wallet files) are exported.
"""
import argparse, json, re, subprocess, time, xml.etree.ElementTree as ET
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--serial',default='emulator-5580');p.add_argument('--apk',required=True);p.add_argument('--evidence',required=True);a=p.parse_args()
out=Path(a.evidence);out.mkdir(parents=True,exist_ok=True)
pkg='run.ripley.androidpoc';base=['adb','-s',a.serial];results={}
def adb(*args,timeout=30,check=True,binary=False):
 r=subprocess.run(base+list(args),capture_output=True,timeout=timeout)
 if check and r.returncode:raise RuntimeError((r.stderr+r.stdout).decode(errors='replace'))
 return r.stdout if binary else r.stdout.decode(errors='replace')
def wait(fn,seconds=30):
 deadline=time.monotonic()+seconds;last=None
 while time.monotonic()<deadline:
  try:
   last=fn()
   if last:return last
  except (RuntimeError,ValueError,ET.ParseError,subprocess.TimeoutExpired):pass
  time.sleep(.5)
 raise RuntimeError(f'timed out after {seconds}s: {last}')
def dump():
 adb('shell','uiautomator','dump','/sdcard/ros-poc-window.xml',timeout=15)
 text=adb('exec-out','cat','/sdcard/ros-poc-window.xml');(out/'last-ui.xml').write_text(text)
 return ET.fromstring(text)
def node(text):
 nodes=list(dump().iter('node'))
 for exact in [True,False]:
  for n in nodes:
   values=[n.get('text','').lower(),n.get('content-desc','').lower()]
   if (text.lower() in values) if exact else any(text.lower() in v for v in values):
    b=list(map(int,re.findall(r'\d+',n.get('bounds',''))))
    if len(b)==4 and b[2]>b[0] and b[3]>b[1]:return b
 return None
def click(text):
 b=wait(lambda:node(text),30);adb('shell','input','tap',str((b[0]+b[2])//2),str((b[1]+b[3])//2))
def shot(name):
 (out/(name+'.png')).write_bytes(adb('exec-out','screencap','-p',binary=True))
def launch():
 adb('shell','am','start','-n',pkg+'/.MainActivity');wait(lambda:node('Android POC diagnostics'),45)
def clear_report(name):
 adb('shell','run-as',pkg,'rm','-f',f'android-poc/{name}.json')
def report(name,seconds=30):
 def load():
  raw=adb('exec-out','run-as',pkg,'cat',f'android-poc/{name}.json',check=False)
  try:return json.loads(raw)
  except ValueError:return None
 v=wait(load,seconds);(out/(name+'.json')).write_text(json.dumps(v,indent=2));return v
try:
 adb('install','-r',a.apk,timeout=90)
 adb('shell','pm','clear',pkg)
 adb('logcat','-c')
 launch();shot('01-actual-ros-ui');results['actualRosLaunch']='PASS'
 click('Android POC diagnostics');wait(lambda:node('Android native POC'));shot('02-diagnostics')
 click('STAGENET TEST ONLY');click('Native create/restore')
 v=report('wallet');results['walletCreateRestoreEncryption']=v
 assert v['mnemonicRestore'] is True and v['encryptedReopen'] and v['wrongPasswordRejected'] and v['tamperRejected']
 click('Bridge boundary');time.sleep(2)
 click('Try hostile navigation');time.sleep(1);assert node('Android native POC');results['hostileNavigationBlocked']='PASS'
 click('Native confirmation');wait(lambda:node('Cancel'));shot('02b-native-confirmation');click('Cancel');v=report('confirmation');assert not v['nativeDialogApproved'];results['nativeConfirmationDenied']='PASS'
 click('Lock test session');report('lock');click('Scan one real');time.sleep(1)
 logs=adb('logcat','-d');assert 'Test session locked' in logs;results['explicitLockRefusesScan']='PASS'
 clear_report('wallet');click('Native create/restore');v=report('wallet');assert v['reopened'];results['walletReopen']=v
 click('Scan one real');results['nativeStagenetScan']=report('scan',55)
 click('Tor + stagenet');results['tor']=report('tor',115)
 (out/'initial-app-logcat.txt').write_text(adb('logcat','-d'));adb('logcat','-c');adb('shell','input','keyevent','KEYCODE_HOME');adb('shell','am','start','-n',pkg+'/.MainActivity');time.sleep(1)
 click('Scan one real');time.sleep(1);logs=adb('logcat','-d');results['backgroundLockObserved']='Test session locked' in logs;assert results['backgroundLockObserved']
 adb('shell','am','force-stop',pkg);adb('shell','svc','wifi','disable');adb('shell','svc','data','disable')
 launch();shot('03-offline-ros-relaunch');results['offlineForceStopRelaunch']='PASS'
 click('Android POC diagnostics');adb('logcat','-c');click('Scan one real');time.sleep(1);assert 'Test session locked' in adb('logcat','-d');results['processDeathStartsLocked']='PASS'
 click('STAGENET TEST ONLY');clear_report('wallet');click('Native create/restore');v=report('wallet');assert v['reopened'] and v['stablePublicAddress'];results['offlineEncryptedReopen']='PASS'
 shot('04-offline-diagnostics')
 adb('shell','svc','wifi','enable');adb('shell','svc','data','enable');results['networkReenabled']='PASS';clear_report('scan');click('Scan one real');results['nativeStagenetScanAfterNetworkRestore']=report('scan',55)
 logs=(out/'initial-app-logcat.txt').read_text()+adb('logcat','-d');(out/'app-logcat.txt').write_text(logs)
 guard=re.findall(r'ANDROID_POC_UI_GUARD[^\n]*',logs);results['uiDiagnosticGuard']=guard
 attacks=re.findall(r'ANDROID_POC_RESULT.*attacks[^\n]*',logs);results['actualBoundaryChecks']=attacks
 assert attacks and '"iframeBlocked":true' in '\n'.join(attacks)
 for cmd in ['get_wallet_keys','create_wallet','unknown_capability_test']:assert f'"{cmd}":"DENIED"' in '\n'.join(attacks)
 runtime=json.loads(re.findall(r'ANDROID_POC_RESULT runtime (\{[^\n]*\})',logs)[-1]);results['typedRuntime']=runtime
 assert runtime['bridgeVersion']==1 and runtime['platform']=='android' and runtime['abi']=='x86_64' and runtime['custody']=='keyless'
 assert runtime['capabilities']['productionSigning'] is False and runtime['capabilities']['remoteBridge'] is False
 assert any('access denied' in x for x in guard)
 results['status']='PASS_WITH_EXPLICIT_NETWORK_LIMITATIONS'
except Exception as e:
 results['status']='FAIL';results['error']=str(e);shot('failure')
finally:
 adb('shell','svc','wifi','enable',check=False);adb('shell','svc','data','enable',check=False)
 (out/'verification.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
if results['status']=='FAIL':raise SystemExit(1)
