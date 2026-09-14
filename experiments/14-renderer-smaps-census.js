const { app, BaseWindow, WebContentsView } = require('electron');
const path=require('path'), fs=require('fs');
const fx = require(path.join(__dirname, '..', 'src/main/fixture-server'));
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
app.commandLine.appendSwitch('host-resolver-rules', fx.HOST_RESOLVER_RULES);
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const s = await fx.start();
  const w = new BaseWindow({width:1000,height:700,show:false});
  const v = new WebContentsView({webPreferences:{sandbox:true}});
  w.contentView.addChildView(v); v.setBounds({x:0,y:0,width:1000,height:700});
  await v.webContents.loadURL(`http://t1.test:${s.port}/bigheap.html?mb=250`);
  for (let i=0;i<120;i++){ if(await v.webContents.executeJavaScript('!!window.__heapReady').catch(()=>false)) break; await sleep(1000); }
  const pid = v.webContents.getOSProcessId();
  fs.writeFileSync('/tmp/renderer.smaps', fs.readFileSync(`/proc/${pid}/smaps`, 'utf8'));
  console.log('__PID__'+pid);
  await s.close(); app.quit();
});
