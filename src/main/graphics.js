'use strict';

/**
 * Is the browser drawing with the graphics card, or with the processor?
 *
 * Chromium keeps a list of graphics drivers it does not trust, and virtual
 * machines' adapters are often on it - VMware's and VirtualBox's among them.
 * On those, pages are drawn by the processor instead, and a 3D game in a tab
 * (WebGL) costs most of the machine: every frame of it rendered in software,
 * on the same cores the page's own code needs. Nothing on screen said so.
 *
 * So the task manager says which it is, and Settings → Advanced can ask
 * Chromium to use the adapter anyway (`ignore-gpu-blocklist`, Chrome's
 * "Override software rendering list"). That is a request, not a promise: an
 * adapter is on the list for a reason, so if the graphics process falls over
 * twice in the first minute with it on, it is turned off again by itself and
 * the next start says why.
 */

const CRASH_WINDOW_MS = 60_000;

/** The switches to add before the app is ready, from the saved preference. */
function applySwitches(app, prefs) {
  if (prefs.get('hardwareAcceleration') === false) return false;
  if (prefs.get('gpuIgnoreBlocklist') !== true) return false;
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  return true;
}

/**
 * Watch the graphics process while the override is on: two crashes soon
 * after start and the override goes, with a note for the next start.
 */
function guardOverride(app, prefs, log = () => {}) {
  if (prefs.get('gpuIgnoreBlocklist') !== true) return;
  const started = Date.now();
  let crashes = 0;
  app.on('child-process-gone', (_event, details) => {
    if (!details || details.type !== 'GPU' || details.reason === 'clean-exit') return;
    if (Date.now() - started > CRASH_WINDOW_MS) return;
    crashes += 1;
    log('graphics', `graphics process gone (${details.reason}) with the override on, ${crashes} time(s)`);
    if (crashes >= 2 && prefs.get('gpuIgnoreBlocklist') === true) {
      prefs.set('gpuIgnoreBlocklist', false);
      prefs.set('gpuOverrideFailed', true);
    }
  });
}

/** The feature status Chromium reports, read as one plain answer. */
function status(app) {
  let features = {};
  try { features = app.getGPUFeatureStatus() || {}; } catch { /* before ready */ }
  const soft = (v) => typeof v === 'string' && /software|disabled|unavailable/.test(v);
  // Each kind of work, as done by the card or by the processor: what a
  // `chrome://gpu` page would say, in two words. Unknown before the graphics
  // process has answered.
  const by = (v) => (!v ? 'unknown' : /^enabled/.test(v) && !soft(v) ? 'card' : 'processor');
  return {
    // The page itself, and 3D in it: either one on the processor is what costs.
    software: soft(features.gpu_compositing) || soft(features.webgl),
    webgl: features.webgl || 'unknown',
    compositing: features.gpu_compositing || 'unknown',
    work: {
      pages: by(features.gpu_compositing),
      threeD: by(features.webgl),
      video: by(features.video_decode),
      drawing: by(features.rasterization)
    },
    overridden: app.commandLine.hasSwitch('ignore-gpu-blocklist')
  };
}

/* ---- What the machine is ------------------------------------------------- */

/**
 * Graphics adapters that are not a graphics card: a hypervisor's display
 * device, or Windows' own fallback. Chromium may still use some of them, but
 * whatever they do is done by the host's processor or by the guest's, and a
 * page drawn on them costs as much as one drawn in software.
 */
const VIRTUAL_ADAPTERS = {
  0x15ad: 'VMware SVGA',
  0x80ee: 'VirtualBox graphics',
  0x1414: 'Microsoft Basic Render Driver',
  0x1234: 'QEMU standard VGA',
  0x1af4: 'virtio graphics',
  0x1b36: 'QXL',
  0x1ab8: 'Parallels graphics',
  0x1013: 'Cirrus Logic (emulated)'
};
const GPU_VENDORS = { 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x1022: 'AMD', 0x8086: 'Intel', 0x106b: 'Apple', 0x5143: 'Qualcomm', 0x13b5: 'Arm' };

/** The hypervisor named by a manufacturer or product string, or null. */
function hypervisorIn(text) {
  const t = String(text || '');
  if (/vmware/i.test(t)) return 'VMware';
  if (/virtualbox|innotek/i.test(t)) return 'VirtualBox';
  if (/parallels/i.test(t)) return 'Parallels';
  if (/qemu|kvm|bochs/i.test(t)) return 'QEMU/KVM';
  if (/\bxen\b/i.test(t)) return 'Xen';
  if (/virtual machine|hyper-v/i.test(t)) return 'Hyper-V';
  return null;
}

/**
 * Is this a virtual machine? Asked of the operating system, not guessed from
 * the graphics: Windows' BIOS strings in the registry, Linux's DMI and the
 * CPU's hypervisor flag, macOS's own answer. Never throws; null when it is not
 * one, or cannot tell.
 */
async function detectVm({ platform = process.platform, run = execFileText, read = readText } = {}) {
  try {
    if (platform === 'win32') {
      const key = 'HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS';
      const out = await run('reg', ['query', key]);
      const field = (name) => (new RegExp(`${name}\\s+REG_SZ\\s+(.+)`, 'i').exec(out) || [])[1] || '';
      return hypervisorIn(`${field('SystemManufacturer')} ${field('SystemProductName')} ${field('BaseBoardManufacturer')}`);
    }
    if (platform === 'linux') {
      const dmi = `${await read('/sys/class/dmi/id/sys_vendor')} ${await read('/sys/class/dmi/id/product_name')}`;
      const named = hypervisorIn(dmi);
      if (named) return named;
      return /\bhypervisor\b/.test(await read('/proc/cpuinfo')) ? 'a virtual machine' : null;
    }
    if (platform === 'darwin') {
      return (await run('sysctl', ['-n', 'kern.hv_vmm_present'])).trim() === '1' ? 'a virtual machine' : null;
    }
  } catch { /* cannot tell */ }
  return null;
}

/** Which adapter Chromium is really drawing with, from its own report. */
async function detectAdapter(app) {
  let info = null;
  try { info = await app.getGPUInfo('basic'); } catch { /* none */ }
  const devices = (info && Array.isArray(info.gpuDevice)) ? info.gpuDevice : [];
  const active = devices.find((d) => d.active) || devices[0] || null;
  if (!active) return { name: 'none found', virtual: true, basic: true, vendorId: 0 };
  const vendorId = Number(active.vendorId) || 0;
  const virtualName = VIRTUAL_ADAPTERS[vendorId];
  const driver = String(active.driverVendor || active.deviceString || '');
  // Drawing in software whatever the adapter: Windows' fallback driver, or a
  // software renderer (SwiftShader reports Google's vendor id with no device).
  const basic = vendorId === 0 || vendorId === 0x1414 ||
    /swiftshader|llvmpipe|softpipe|basic render/i.test(`${driver} ${active.deviceString || ''}`);
  return {
    vendorId,
    name: vendorId === 0 ? 'no graphics adapter' : virtualName || active.deviceString || GPU_VENDORS[vendorId] || driver ||
      `vendor 0x${vendorId.toString(16)}`,
    // A hypervisor's display device. With the VM's 3D acceleration on it hands
    // work to the host's card, so on its own it is not "no graphics card".
    virtual: Boolean(virtualName) || basic,
    basic
  };
}

/**
 * Everything at once, for the browser to decide by and to show: the VM, the
 * adapter, and whether pages end up drawn by the processor.
 */
async function detectMachine(app, opts = {}) {
  const [vm, adapter] = await Promise.all([detectVm(opts), detectAdapter(app)]);
  const drawing = status(app);
  return {
    vm,
    adapter: adapter.name,
    virtualAdapter: adapter.virtual,
    software: drawing.software,
    work: drawing.work,
    // No graphics card doing the work: pages drawn in software, or by a
    // driver that is software underneath.
    noGpu: drawing.software || adapter.basic,
    at: Date.now()
  };
}

/**
 * Light graphics: chosen, or found to be needed - no graphics card doing the
 * work, or a virtual machine drawing through its own display adapter. A VM
 * with a real card passed through to it is not light.
 */
function isLight(mode, detected) {
  if (mode === 'light') return true;
  if (mode === 'full') return false;
  return Boolean(detected && (detected.noGpu || (detected.vm && detected.virtualAdapter)));
}

/** "3D and video on the processor; pages on the card" - which work goes where. */
function workLine(work) {
  if (!work) return '';
  const names = { pages: 'pages', threeD: '3D (WebGL)', video: 'video decoding', drawing: 'drawing' };
  const on = (where) => Object.keys(names).filter((k) => work[k] === where).map((k) => names[k]);
  const card = on('card');
  const cpu = on('processor');
  const parts = [];
  if (card.length) parts.push(`${card.join(', ')} on the graphics card`);
  if (cpu.length) parts.push(`${cpu.join(', ')} on the processor`);
  return parts.length ? `${parts.join('; ')}.` : '';
}

/** In plain words, for Settings and the task manager. */
function describe(detected) {
  if (!detected || !detected.at) return 'Not checked yet';
  const where = detected.vm ? `${detected.vm === 'a virtual machine' ? 'A virtual machine' : `A ${detected.vm} virtual machine`}` : 'This computer';
  if (detected.noGpu) return `${where} with no graphics card in use (${detected.adapter}): pages are drawn by the processor`;
  if (detected.vm && detected.virtualAdapter) return `${where}, drawing through its virtual display (${detected.adapter})`;
  return `${where}, drawing with ${detected.adapter}`;
}

function execFileText(cmd, args) {
  return new Promise((resolve) => {
    require('child_process').execFile(cmd, args, { timeout: 3000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}
function readText(file) {
  return require('fs').promises.readFile(file, 'utf8').catch(() => '');
}

module.exports = { applySwitches, guardOverride, status, detectVm, detectAdapter, detectMachine, hypervisorIn, isLight, describe, workLine,
  VIRTUAL_ADAPTERS };
