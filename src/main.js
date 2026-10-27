'use strict';

const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  net,
  protocol,
  screen,
  session,
  shell,
} = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');

const runFile = promisify(execFile);

const SELF_TEST = process.argv.includes('--self-test');
const CROP_TEST = process.argv.includes('--crop-test');
const MIC_TEST = process.argv.includes('--mic-test');
const FLOATING_TEST = process.argv.includes('--floating-test');
const TUTORIAL_TEST = process.argv.includes('--tutorial-test');
const SMOKE = process.argv.includes('--smoke');
const DEV = process.argv.includes('--dev');
const ROOT = path.join(__dirname, '..');
const SELF_TEST_DIR = path.join(process.cwd(), 'selftest-output');
const APP_NAME = 'VRZ Studio';
const LEGACY_APP_NAME = 'VRL Studio';

// Cache de disco acotada: menos escrituras y menos RAM en equipos con poco espacio.
app.commandLine.appendSwitch('disk-cache-size', String(32 * 1024 * 1024));

// Modo bajo consumo automático en equipos modestos (netbook): Chromium reduce
// memoria de composición, efectos y procesos en segundo plano.
const LOW_END =
  process.env.VRZ_LOW_END === '1' ||
  os.totalmem() <= 6 * 1024 ** 3 ||
  os.cpus().length <= 2;
if (LOW_END) {
  app.commandLine.appendSwitch('enable-low-end-device-mode');
  app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess');
}

// Solo en equipos modestos la app cede CPU al resto del sistema. En un equipo
// con recursos (PC de escritorio) conserva prioridad normal para grabar mejor.
try {
  os.setPriority(
    0,
    LOW_END
      ? os.constants.priority.PRIORITY_BELOW_NORMAL
      : os.constants.priority.PRIORITY_NORMAL,
  );
} catch {
  /* sin permisos para cambiar la prioridad */
}

const PORTABLE_FLAG = 'portable.flag';
const PORTABLE_ROOT = path.join(path.dirname(process.execPath), `${APP_NAME} Data`);
const LEGACY_PORTABLE_ROOT = path.join(path.dirname(process.execPath), `${LEGACY_APP_NAME} Data`);
const IS_PORTABLE = app.isPackaged && fs.existsSync(path.join(path.dirname(process.execPath), PORTABLE_FLAG));
if (IS_PORTABLE) {
  if (!fs.existsSync(PORTABLE_ROOT) && fs.existsSync(LEGACY_PORTABLE_ROOT)) {
    try {
      fs.renameSync(LEGACY_PORTABLE_ROOT, PORTABLE_ROOT);
    } catch {
      /* si no se puede migrar, se empieza con datos nuevos */
    }
  }
  fs.mkdirSync(path.join(PORTABLE_ROOT, 'appdata'), { recursive: true });
  fs.mkdirSync(path.join(PORTABLE_ROOT, 'session'), { recursive: true });
  app.setPath('userData', path.join(PORTABLE_ROOT, 'appdata'));
  app.setPath('sessionData', path.join(PORTABLE_ROOT, 'session'));
} else {
  try {
    const current = path.join(app.getPath('appData'), APP_NAME);
    const legacy = path.join(app.getPath('appData'), LEGACY_APP_NAME);
    if (!fs.existsSync(current) && fs.existsSync(legacy)) fs.renameSync(legacy, current);
  } catch {
    /* sin migracion de ajustes */
  }
}

if (TUTORIAL_TEST) {
  const testData = path.join(process.cwd(), 'tutorial-test-userdata');
  fs.mkdirSync(path.join(testData, 'appdata'), { recursive: true });
  fs.mkdirSync(path.join(testData, 'session'), { recursive: true });
  app.setPath('userData', path.join(testData, 'appdata'));
  app.setPath('sessionData', path.join(testData, 'session'));
}

let recDir =
  process.env.VRZ_REC_DIR ||
  process.env.VRL_REC_DIR ||
  (IS_PORTABLE ? path.join(PORTABLE_ROOT, 'Grabaciones') : path.join(app.getPath('videos'), APP_NAME));
if (SELF_TEST) recDir = SELF_TEST_DIR;
else if (CROP_TEST && !process.env.VRL_REC_DIR) recDir = path.join(process.cwd(), 'croptest-output');
else if (MIC_TEST && !process.env.VRL_REC_DIR) recDir = path.join(process.cwd(), 'mictest-output');
else if (TUTORIAL_TEST && !process.env.VRZ_REC_DIR) recDir = path.join(process.cwd(), 'tutorial-test-output');

const MIC_HOLD_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class VrlKeyState {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
}
"@
$prev = $false
while ($true) {
  $ctrl = ([VrlKeyState]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0
  $shift = ([VrlKeyState]::GetAsyncKeyState(0x10) -band 0x8000) -ne 0
  $key = ([VrlKeyState]::GetAsyncKeyState(0x4D) -band 0x8000) -ne 0
  $down = $ctrl -and $shift -and $key
  if ($down -ne $prev) {
    if ($down) { [Console]::Out.WriteLine('DOWN') } else { [Console]::Out.WriteLine('UP') }
    [Console]::Out.Flush()
    $prev = $down
  }
  Start-Sleep -Milliseconds 45
}
`;

let micHoldProc = null;
let micHoldBuffer = '';
const recSessions = new Map();

function stopMicHoldWatcher() {
  if (micHoldProc) {
    try {
      micHoldProc.kill();
    } catch {
      /* ya terminó */
    }
    micHoldProc = null;
  }
  micHoldBuffer = '';
}

function startMicHoldWatcher() {
  if (micHoldProc) return;
  const encoded = Buffer.from(MIC_HOLD_SCRIPT, 'utf16le').toString('base64');
  micHoldProc = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  micHoldProc.stdout.setEncoding('utf8');
  micHoldProc.stdout.on('data', (chunk) => {
    micHoldBuffer += chunk;
    const lines = micHoldBuffer.split(/\r?\n/);
    micHoldBuffer = lines.pop() || '';
    lines.forEach((line) => {
      const value = line.trim();
      if (value !== 'DOWN' && value !== 'UP') return;
      if (win && !win.isDestroyed()) {
        win.webContents.send(value === 'DOWN' ? 'shortcut:mic-hold-start' : 'shortcut:mic-hold-end');
      }
    });
  });
  micHoldProc.on('exit', () => {
    micHoldProc = null;
  });
}

let win = null;
let floatingWin = null;
let pendingSourceId = null;
let pendingSystemAudio = false;
let selfTestTimer = null;
let floatingSaveTimer = null;
const FLOATING_WIDTH = 240;
const FLOATING_HEIGHT = 58;
let floatingState = {
  recording: false,
  saving: false,
  paused: false,
  micLive: false,
  micStarting: false,
  elapsed: 0,
  accent: '#7c5cff',
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'vrl',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

const MIME = {
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.json': 'application/json',
};

function safeName(value) {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  return cleaned || 'Grabacion';
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function uniqueBase(dir, base) {
  let candidate = base;
  let n = 2;
  while (fs.existsSync(path.join(dir, `${candidate}.webm`))) {
    candidate = `${base} (${n})`;
    n += 1;
  }
  return candidate;
}

async function listSources() {
  const primaryId = String(screen.getPrimaryDisplay().id);
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 480, height: 270 },
    fetchWindowIcons: true,
  });
  return sources
    .filter((s) => !s.name.includes(APP_NAME))
    .map((s) => ({
      id: s.id,
      name: s.name,
      type: s.id.startsWith('screen') ? 'screen' : 'window',
      displayId: s.display_id || null,
      primary: Boolean(s.display_id) && String(s.display_id) === primaryId,
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }));
}

function resolveFfmpeg() {
  const candidates = [
    process.env.VRL_FFMPEG,
    path.join(path.dirname(process.execPath), 'ffmpeg.exe'),
    process.resourcesPath ? path.join(process.resourcesPath, 'ffmpeg.exe') : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (require('fs').existsSync(candidate)) return candidate;
    } catch {
    }
  }
  return 'ffmpeg';
}

async function fixWebmDuration(file) {
  const ffmpeg = resolveFfmpeg();
  const temp = file.replace(/\.webm$/, '.remux.webm');
  try {
    await runFile(
      ffmpeg,
      ['-y', '-loglevel', 'error', '-i', file, '-map', '0', '-c', 'copy', temp],
      { timeout: 15 * 60 * 1000, windowsHide: true },
    );
    const stat = await fsp.stat(temp);
    if (stat.size > 1024) {
      await fsp.rename(temp, file);
    } else {
      await fsp.unlink(temp).catch(() => {});
    }
  } catch (err) {
    await fsp.unlink(temp).catch(() => {});
    console.warn('[ffmpeg] No se pudo corregir la duracion del .webm:', err && err.message ? err.message : err);
  }
}

async function readLibrary() {
  await fsp.mkdir(recDir, { recursive: true });
  const entries = await fsp.readdir(recDir);
  const items = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.webm') || entry.startsWith('.vrl-part-')) continue;
    const file = path.join(recDir, entry);
    try {
      const stat = await fsp.stat(file);
      const base = entry.replace(/\.webm$/i, '');
      const sidecar = path.join(recDir, `${base}.json`);
      const thumb = path.join(recDir, `${base}.jpg`);
      let meta = {};
      if (fs.existsSync(sidecar)) {
        try {
          meta = JSON.parse(await fsp.readFile(sidecar, 'utf8'));
        } catch {
          meta = {};
        }
      }
      items.push({
        title: base,
        createdAt:
          meta.createdAt ||
          (stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime).toISOString(),
        duration: Number(meta.duration) || 0,
        width: Number(meta.width) || 0,
        height: Number(meta.height) || 0,
        file,
        filename: entry,
        size: stat.size,
        thumbUrl: fs.existsSync(thumb) ? `vrl://local/${encodeURIComponent(path.basename(thumb))}` : null,
        videoUrl: `vrl://local/${encodeURIComponent(path.basename(file))}`,
      });
    } catch {
      /* archivo no legible */
    }
  }
  items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return items;
}

async function finalizeRecordingFile(tempPath, meta) {
  const title = safeName(meta.title || `Grabacion ${stamp()}`);
  const base = uniqueBase(recDir, title);
  const file = path.join(recDir, `${base}.webm`);
  const tempStat = await fsp.stat(tempPath);
  const createdAt =
    (tempStat.birthtimeMs > 0 ? tempStat.birthtime : tempStat.mtime).toISOString();
  await fsp.rename(tempPath, file);
  await fixWebmDuration(file);

  const stat = await fsp.stat(file);
  return {
    title: base,
    file,
    filename: path.basename(file),
    createdAt,
    duration: Number(meta.duration) || 0,
    width: Number(meta.width) || 0,
    height: Number(meta.height) || 0,
    size: stat.size,
    thumbUrl: null,
    videoUrl: `vrl://local/${encodeURIComponent(path.basename(file))}`,
  };
}

async function commitRecordingBuffer(buffer, meta) {
  await fsp.mkdir(recDir, { recursive: true });
  const tempPath = path.join(recDir, `.vrl-part-${crypto.randomUUID()}.webm`);
  await fsp.writeFile(tempPath, Buffer.from(buffer));
  try {
    return await finalizeRecordingFile(tempPath, meta || {});
  } catch (err) {
    await fsp.unlink(tempPath).catch(() => {});
    throw err;
  }
}

async function migrateLegacyRecordings() {
  if (IS_PORTABLE || SELF_TEST || CROP_TEST || MIC_TEST) return;
  if (process.env.VRZ_REC_DIR || process.env.VRL_REC_DIR) return;
  try {
    const legacy = path.join(app.getPath('videos'), LEGACY_APP_NAME);
    if (!fs.existsSync(legacy)) return;
    if (!fs.existsSync(recDir)) {
      await fsp.rename(legacy, recDir);
      return;
    }
    const current = await fsp.readdir(recDir).catch(() => []);
    if (current.length === 0) {
      await fsp.rmdir(recDir).catch(() => {});
      await fsp.rename(legacy, recDir);
    }
  } catch {
    /* si falla, se conserva la carpeta anterior */
  }
}

async function cleanupStaleParts() {
  try {
    await fsp.mkdir(recDir, { recursive: true });
    const entries = await fsp.readdir(recDir);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of entries) {
      if (!name.startsWith('.vrl-part-')) continue;
      const full = path.join(recDir, name);
      try {
        const stat = await fsp.stat(full);
        if (stat.mtimeMs < cutoff) await fsp.unlink(full);
      } catch {
        /* archivo en uso o ya eliminado */
      }
    }
  } catch {
    /* noop */
  }
}

function registerIpc() {
  ipcMain.handle('sources:list', async () => listSources());

  ipcMain.handle('capture:select', (_event, payload) => {
    pendingSourceId = payload?.id || null;
    pendingSystemAudio = Boolean(payload?.systemAudio);
    return Boolean(pendingSourceId);
  });

  ipcMain.handle('recording:save', async (_event, payload) => {
    return commitRecordingBuffer(payload?.buffer, payload?.meta || {});
  });

  ipcMain.handle('recording:begin', async () => {
    await fsp.mkdir(recDir, { recursive: true });
    const id = crypto.randomUUID();
    const tempPath = path.join(recDir, `.vrl-part-${id}.webm`);
    await fsp.writeFile(tempPath, Buffer.alloc(0));
    recSessions.set(id, { tempPath, chain: Promise.resolve(), bytes: 0 });
    return id;
  });

  ipcMain.handle('recording:chunk', async (_event, payload) => {
    const session = recSessions.get(payload?.id);
    if (!session) throw new Error('Sesión de grabación no encontrada.');
    const buffer = Buffer.from(payload.chunk);
    session.chain = session.chain.then(async () => {
      await fsp.appendFile(session.tempPath, buffer);
      session.bytes += buffer.length;
    });
    await session.chain;
    return true;
  });

  ipcMain.handle('recording:finish', async (_event, payload) => {
    const session = recSessions.get(payload?.id);
    if (!session) throw new Error('Sesión de grabación no encontrada.');
    try {
      await session.chain;
      if (!session.bytes) throw new Error('La grabación quedó vacía.');
      return await finalizeRecordingFile(session.tempPath, payload.meta || {});
    } finally {
      recSessions.delete(payload.id);
      await fsp.unlink(session.tempPath).catch(() => {});
    }
  });

  ipcMain.handle('recording:cancel', async (_event, id) => {
    const session = recSessions.get(id);
    if (!session) return false;
    recSessions.delete(id);
    await session.chain.catch(() => {});
    await fsp.unlink(session.tempPath).catch(() => {});
    return true;
  });

  ipcMain.handle('library:list', async () => readLibrary());

  ipcMain.handle('library:rename', async (_event, payload) => {
    const target = path.resolve(payload.file);
    if (!target.startsWith(path.resolve(recDir)) || !target.toLowerCase().endsWith('.webm')) {
      throw new Error('Ruta no permitida');
    }
    if (!fs.existsSync(target)) throw new Error('La grabación ya no existe.');
    const currentBase = path.basename(target, path.extname(target));
    const title = safeName(payload.title);
    if (title === currentBase) return readLibrary();
    const base = uniqueBase(recDir, title);
    const renamed = path.join(recDir, `${base}.webm`);
    await fsp.rename(target, renamed);
    for (const ext of ['.json', '.jpg']) {
      const oldSidecar = path.join(recDir, `${currentBase}${ext}`);
      const newSidecar = path.join(recDir, `${base}${ext}`);
      if (fs.existsSync(oldSidecar)) await fsp.rename(oldSidecar, newSidecar).catch(() => {});
    }
    return readLibrary();
  });

  ipcMain.handle('library:delete', async (_event, payload) => {
    const target = path.resolve(payload.file);
    if (!target.startsWith(path.resolve(recDir))) throw new Error('Ruta no permitida');
    const base = target.replace(/\.webm$/, '');
    for (const ext of ['.webm', '.jpg', '.json']) {
      const candidate = `${base}${ext}`;
      if (fs.existsSync(candidate)) {
        try {
          await shell.trashItem(candidate);
        } catch {
          await fsp.unlink(candidate).catch(() => {});
        }
      }
    }
    return readLibrary();
  });

  ipcMain.handle('library:reveal', (_event, payload) => {
    shell.showItemInFolder(path.resolve(payload.file));
    return true;
  });

  ipcMain.handle('library:open-file', async (_event, payload) => {
    return shell.openPath(path.resolve(payload.file));
  });

  ipcMain.handle('floating:state', (_event, payload) => {
    applyFloatingState(payload);
    return true;
  });

  ipcMain.handle('floating:get-state', () => floatingState);

  ipcMain.handle('floating:restore', () => {
    restoreMainWindow();
    return true;
  });

  ipcMain.on('floating:action', (_event, action) => {
    handleFloatingAction(action);
  });

  ipcMain.handle('app:info', async () => {
    let freeSpace = 0;
    try {
      const stats = await fsp.statfs(recDir);
      freeSpace = Number(stats.bavail) * Number(stats.bsize);
    } catch {
      /* sin datos de disco */
    }
    const display = screen.getPrimaryDisplay();
    return {
      version: app.getVersion(),
      recDir,
      platform: process.platform,
      selfTest: SELF_TEST,
      portable: IS_PORTABLE,
      lowEnd: LOW_END,
      freeSpace,
      primaryDisplay: { bounds: display.bounds, workArea: display.workArea },
    };
  });

  ipcMain.handle('app:open-folder', async () => {
    await fsp.mkdir(recDir, { recursive: true });
    return shell.openPath(recDir);
  });

  ipcMain.handle('app:choose-folder', async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: recDir,
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('win:control', (event, action) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    if (!target) return;
    if (action === 'min') target.minimize();
    else if (action === 'max') target.isMaximized() ? target.unmaximize() : target.maximize();
    else if (action === 'close') target.close();
    else if (action === 'hide') target.hide();
    else if (action === 'show') target.show();
  });

  ipcMain.handle('mic-hold:watch', (_event, active) => {
    if (active) startMicHoldWatcher();
    else stopMicHoldWatcher();
    return true;
  });

  ipcMain.handle('selftest:done', async (_event, result) => {
    if (!SELF_TEST) return false;
    const log = path.join(SELF_TEST_DIR, 'self-test.log');
    await fsp.mkdir(SELF_TEST_DIR, { recursive: true });
    await fsp.writeFile(log, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    if (selfTestTimer) clearTimeout(selfTestTimer);
    setTimeout(() => app.exit(result?.ok ? 0 : 1), 250);
    return true;
  });
}

function floatingBoundsFile() {
  return path.join(app.getPath('userData'), 'floating-window.json');
}

function readFloatingPosition() {
  try {
    const value = JSON.parse(fs.readFileSync(floatingBoundsFile(), 'utf8'));
    if (Number.isFinite(value.x) && Number.isFinite(value.y)) {
      return { x: Math.round(value.x), y: Math.round(value.y) };
    }
  } catch {
    /* sin posicion guardada */
  }
  return null;
}

function floatingDefaultBounds() {
  const anchor = win && !win.isDestroyed() ? win.getBounds() : screen.getPrimaryDisplay().bounds;
  const area = screen.getDisplayMatching(anchor).workArea;
  return {
    x: area.x + area.width - FLOATING_WIDTH - 22,
    y: area.y + area.height - FLOATING_HEIGHT - 22,
    width: FLOATING_WIDTH,
    height: FLOATING_HEIGHT,
  };
}

function isFloatingReachable(bounds) {
  return screen.getAllDisplays().some(({ workArea: area }) => {
    const overlapW =
      Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapH =
      Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapW >= 28 && overlapH >= 14;
  });
}

function floatingBounds() {
  const saved = readFloatingPosition();
  if (saved) {
    const bounds = {
      x: saved.x,
      y: saved.y,
      width: FLOATING_WIDTH,
      height: FLOATING_HEIGHT,
    };
    return isFloatingReachable(bounds) ? bounds : floatingDefaultBounds();
  }
  return floatingDefaultBounds();
}

function scheduleFloatingSave() {
  if (!floatingWin || floatingWin.isDestroyed()) return;
  if (floatingSaveTimer) clearTimeout(floatingSaveTimer);
  floatingSaveTimer = setTimeout(async () => {
    floatingSaveTimer = null;
    if (!floatingWin || floatingWin.isDestroyed()) return;
    const bounds = floatingWin.getBounds();
    try {
      await fsp.mkdir(path.dirname(floatingBoundsFile()), { recursive: true });
      await fsp.writeFile(
        floatingBoundsFile(),
        JSON.stringify({ x: bounds.x, y: bounds.y }, null, 2),
        'utf8',
      );
    } catch {
      /* noop */
    }
  }, 250);
}

function sendFloatingState() {
  if (!floatingWin || floatingWin.isDestroyed()) return;
  try {
    floatingWin.webContents.send('floating:state', floatingState);
  } catch {
    /* ventana aun cargando */
  }
}

function ensureFloatingWindow() {
  if (floatingWin && !floatingWin.isDestroyed()) return floatingWin;
  const bounds = floatingBounds();
  floatingWin = new BrowserWindow({
    width: FLOATING_WIDTH,
    height: FLOATING_HEIGHT,
    x: bounds.x,
    y: bounds.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: `${APP_NAME} flotante`,
    webPreferences: {
      preload: path.join(__dirname, 'floating-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  floatingWin.setAlwaysOnTop(true, 'screen-saver');
  floatingWin.setContentProtection(true);
  floatingWin.loadFile(path.join(__dirname, 'renderer', 'floating.html'));
  floatingWin.webContents.on('did-finish-load', sendFloatingState);
  floatingWin.on('moved', scheduleFloatingSave);
  floatingWin.on('close', (event) => {
    event.preventDefault();
    hideFloating();
  });
  floatingWin.on('closed', () => {
    floatingWin = null;
  });
  return floatingWin;
}

function showFloating() {
  if (!floatingState.recording && !floatingState.saving) return;
  const target = ensureFloatingWindow();
  if (!isFloatingReachable(target.getBounds())) target.setBounds(floatingDefaultBounds());
  target.setContentProtection(true);
  sendFloatingState();
  target.showInactive();
}

function hideFloating() {
  if (floatingWin && !floatingWin.isDestroyed() && floatingWin.isVisible()) floatingWin.hide();
}

function closeFloatingWindow() {
  if (floatingSaveTimer) clearTimeout(floatingSaveTimer);
  floatingSaveTimer = null;
  if (floatingWin && !floatingWin.isDestroyed()) floatingWin.destroy();
  floatingWin = null;
}

function syncFloatingVisibility() {
  if (!win || win.isDestroyed()) {
    hideFloating();
    return;
  }
  const active = floatingState.recording || floatingState.saving;
  if (active) showFloating();
  else hideFloating();
}

function applyFloatingState(payload) {
  const value = payload || {};
  floatingState = {
    recording: Boolean(value.recording),
    saving: Boolean(value.saving),
    paused: Boolean(value.paused),
    micLive: Boolean(value.micLive),
    micStarting: Boolean(value.micStarting),
    elapsed: Math.max(0, Number(value.elapsed) || 0),
    accent: typeof value.accent === 'string' ? value.accent : '#7c5cff',
  };
  sendFloatingState();
  syncFloatingVisibility();
}

function restoreMainWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  hideFloating();
}

function handleFloatingAction(action) {
  if (!win || win.isDestroyed()) return;
  if (!['stop', 'pause', 'mic'].includes(action)) return;
  if (action === 'stop') restoreMainWindow();
  win.webContents.send('floating:action', action);
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1200, Math.max(880, area.width - 40));
  const height = Math.min(780, Math.max(520, area.height - 40));
  win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(980, width),
    minHeight: Math.min(660, height),
    center: true,
    show: false,
    frame: false,
    backgroundColor: '#0a0c10',
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: SELF_TEST
      ? { selftest: '1' }
      : CROP_TEST
        ? { croptest: '1' }
        : MIC_TEST
          ? { mictest: '1' }
          : {},
  });

  if (SELF_TEST) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        win.webContents
          .executeJavaScript('window.__vrlSelfTestStart && window.__vrlSelfTestStart()', true)
          .catch(() => {});
      }, 1400);
    });
  }

  if (CROP_TEST) {
    const logFile = path.join(process.cwd(), 'crop-test.log');
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const shotTimer = setTimeout(async () => {
          try {
            const image = await win.webContents.capturePage();
            await fsp.writeFile(path.join(process.cwd(), 'crop-modal.png'), image.toPNG());
          } catch {
            /* noop */
          }
        }, 3800);

        try {
          const result = await Promise.race([
            win.webContents.executeJavaScript(
              'window.__vrlCropTest && window.__vrlCropTest()',
              true,
            ),
            new Promise((resolve) =>
              setTimeout(() => resolve({ ok: false, error: 'timeout' }), 45000),
            ),
          ]);
          clearTimeout(shotTimer);
          await fsp.writeFile(logFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
          app.exit(result?.ok ? 0 : 1);
        } catch (err) {
          clearTimeout(shotTimer);
          await fsp.writeFile(
            logFile,
            `${JSON.stringify({ ok: false, error: err?.stack || String(err) }, null, 2)}\n`,
            'utf8',
          );
          app.exit(1);
        }
      }, 1800);
    });
  }

  if (MIC_TEST) {
    const logFile = path.join(process.cwd(), 'mic-test.log');
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const result = await Promise.race([
            win.webContents.executeJavaScript('window.__vrlMicTest && window.__vrlMicTest()', true),
            new Promise((resolve) =>
              setTimeout(() => resolve({ ok: false, error: 'timeout' }), 60000),
            ),
          ]);
          await fsp.writeFile(logFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
          app.exit(result?.ok ? 0 : 1);
        } catch (err) {
          await fsp.writeFile(
            logFile,
            `${JSON.stringify({ ok: false, error: err?.stack || String(err) }, null, 2)}\n`,
            'utf8',
          );
          app.exit(1);
        }
      }, 1800);
    });
  }

  if (SMOKE) {
    const logFile = path.join(process.cwd(), 'smoke.log');
    const lines = [];
    win.webContents.on('console-message', (event) => {
      lines.push(
        `[${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`,
      );
    });
    win.webContents.once('did-finish-load', async () => {
      try {
        const probe = await win.webContents.executeJavaScript(
          `({
            title: document.title,
            hasApi: Boolean(window.vrl),
            hasCanvas: Boolean(document.getElementById('canvas')),
            hasRecord: Boolean(document.getElementById('btnRecord')),
            sections: document.querySelectorAll('.view').length
          })`,
        );
        lines.push(`probe=${JSON.stringify(probe)}`);
      } catch (err) {
        lines.push(`probe-error=${err.message}`);
      }
      await fsp.writeFile(logFile, `${lines.join('\n')}\n`, 'utf8');
      setTimeout(async () => {
        try {
          const shots = [
            ['smoke.png', null],
            ['smoke-settings.png', `document.querySelector('[data-view="settings"]').click()`],
            ['smoke-library.png', `document.querySelector('[data-view="library"]').click()`],
          ];
          for (const [name, script] of shots) {
            if (script) {
              await win.webContents.executeJavaScript(script);
              await new Promise((resolve) =>
                setTimeout(resolve, name === 'smoke-library.png' ? 2200 : 450),
              );
            }
            const image = await win.webContents.capturePage();
            await fsp.writeFile(path.join(process.cwd(), name), image.toPNG());
          }
          const diag = await win.webContents.executeJavaScript(
            `(async () => {
              const items = await window.vrl.listLibrary();
              const first = items[0];
              const img = document.querySelector('.card-thumb img');
              const range = first
                ? await fetch(first.videoUrl, { headers: { Range: 'bytes=0-1023' } })
                : null;
              const body = range ? await range.arrayBuffer() : null;
              return {
                count: items.length,
                first: first ? { file: first.file, size: first.size, url: first.videoUrl.slice(0, 80) } : null,
                img: img
                  ? { src: String(img.src).slice(0, 32), complete: img.complete, width: img.naturalWidth, cls: img.className, parent: img.parentElement.className }
                  : null,
                range: range
                  ? { status: range.status, length: range.headers.get('content-length'), contentRange: range.headers.get('content-range'), acceptRanges: range.headers.get('accept-ranges'), bytes: body.byteLength }
                  : null
              };
            })()`,
          );
          lines.push(`diag=${JSON.stringify(diag)}`);
        } catch (err) {
          lines.push(`diag-error=${err.message}`);
        }
        await fsp.writeFile(logFile, `${lines.join('\n')}\n`, 'utf8');
        app.quit();
      }, 900);
    });
  }

  win.once('ready-to-show', () => {
    if (!SELF_TEST && !CROP_TEST && !MIC_TEST) win.show();
  });

  win.on('minimize', () => {
    if (floatingState.recording || floatingState.saving) showFloating();
  });
  win.on('restore', syncFloatingVisibility);
  win.on('show', () => {
    syncFloatingVisibility();
  });
  win.on('closed', () => {
    stopMicHoldWatcher();
    closeFloatingWindow();
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    if (SELF_TEST || CROP_TEST || MIC_TEST) app.exit(1);
    else dialog.showErrorBox(APP_NAME, `El proceso de la interfaz se detuvo: ${details.reason}`);
  });

  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
}

// Una sola instancia: en equipos lentos es fácil abrir la app dos veces sin
// querer (cada instancia consume ~450 MB de RAM y congela el sistema).
const TEST_MODE = SELF_TEST || CROP_TEST || MIC_TEST || FLOATING_TEST || TUTORIAL_TEST;
if (!TEST_MODE) {
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
  } else {
    app.on('second-instance', () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
  }
}

app.whenReady().then(async () => {
  await migrateLegacyRecordings();
  await cleanupStaleParts();
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = ['media', 'display-capture', 'audioCapture', 'videoCapture'];
    callback(allowed.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return ['media', 'display-capture', 'audioCapture', 'videoCapture'].includes(permission);
  });

  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        const chosen = sources.find((s) => s.id === pendingSourceId) || sources[0];
        if (!chosen) {
          callback({});
          return;
        }
        const wantsAudio = Boolean(request.audioRequested) || pendingSystemAudio;
        if (wantsAudio) callback({ video: chosen, audio: 'loopback' });
        else callback({ video: chosen });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false },
  );

  protocol.handle('vrl', async (request) => {
    try {
      const url = new URL(request.url);
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const target = path.resolve(recDir, name);
      if (!target.startsWith(path.resolve(recDir))) {
        return new Response('Forbidden', { status: 403 });
      }
      const stat = await fsp.stat(target);
      if (!stat.isFile()) return new Response('Not found', { status: 404 });
      const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      const cors = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'range',
        'access-control-expose-headers': 'content-range, content-length, accept-ranges',
      };
      const range = request.headers.get('range');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (!match) return new Response('Range Not Satisfiable', { status: 416 });
        let start;
        let end;
        if (!match[1]) {
          const suffix = Number(match[2]);
          if (!Number.isFinite(suffix) || suffix <= 0) {
            return new Response('Range Not Satisfiable', { status: 416 });
          }
          start = Math.max(0, stat.size - suffix);
          end = stat.size - 1;
        } else {
          start = Number(match[1]);
          end = match[2] ? Number(match[2]) : stat.size - 1;
        }
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start < 0 ||
          start >= stat.size ||
          start > end
        ) {
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: { 'content-range': `bytes */${stat.size}` },
          });
        }
        end = Math.min(end, stat.size - 1);
        const headers = {
          ...cors,
          'content-type': type,
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${stat.size}`,
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
        };
        if (request.method === 'HEAD') return new Response(null, { status: 206, headers });
        return new Response(Readable.toWeb(fs.createReadStream(target, { start, end })), {
          status: 206,
          headers,
        });
      }
      const headers = {
        ...cors,
        'content-type': type,
        'content-length': String(stat.size),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      };
      if (request.method === 'HEAD') return new Response(null, { headers });
      return new Response(Readable.toWeb(fs.createReadStream(target)), { headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  registerIpc();
  createWindow();

  if (FLOATING_TEST) {
    setTimeout(async () => {
      try {
        applyFloatingState({
          recording: true,
          saving: false,
          paused: false,
          micLive: true,
          micStarting: false,
          elapsed: 754,
          accent: '#7c5cff',
        });
        const target = ensureFloatingWindow();
        const miniConsole = [];
        target.webContents.on('console-message', (event) => {
          miniConsole.push(
            JSON.stringify({
              level: event.level,
              message: event.message,
              line: event.lineNumber,
              source: event.sourceId,
            }),
          );
        });
        win.minimize();
        await new Promise((resolve) => setTimeout(resolve, 900));
        const visibleWhileMinimized = target.isVisible();
        const probe = await target.webContents.executeJavaScript(
          `({
            api: typeof window.mini,
            loaded: Boolean(window.__miniLoaded),
            ready: Boolean(window.__miniReady),
            error: window.__miniError || '',
            time: document.getElementById('time').textContent,
            status: document.getElementById('status').textContent,
            micOn: document.getElementById('mic').classList.contains('on'),
            pauseDisabled: document.getElementById('pause').disabled,
            stopDisabled: document.getElementById('stop').disabled
          })`,
        );
        const originalBounds = target.getBounds();
        const workArea = screen.getDisplayMatching(originalBounds).workArea;
        const desired = { x: workArea.x + 41, y: workArea.y + 37 };
        target.setPosition(desired.x, desired.y);
        await new Promise((resolve) => setTimeout(resolve, 350));
        const movedBounds = target.getBounds();
        target.hide();
        showFloating();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const reShownBounds = target.getBounds();
        let image = null;
        let captureError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            image = await target.webContents.capturePage();
            if (!image.isEmpty()) break;
          } catch (err) {
            captureError = err;
            image = null;
            await new Promise((resolve) => setTimeout(resolve, 350));
          }
        }
        if (!image || image.isEmpty()) {
          throw captureError || new Error('No se pudo capturar el control flotante.');
        }
        await fsp.writeFile(path.join(process.cwd(), 'floating-test.png'), image.toPNG());
        applyFloatingState({
          recording: true,
          saving: false,
          paused: true,
          micLive: false,
          micStarting: false,
          elapsed: 754,
          accent: '#7c5cff',
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        const pausedProbe = await target.webContents.executeJavaScript(
          `({
            status: document.getElementById('status').textContent,
            micOn: document.getElementById('mic').classList.contains('on'),
            pauseTitle: document.getElementById('pause').title,
            playIcon: Boolean(document.querySelector('#pause .play-glyph'))
          })`,
        );
        win.restore();
        await new Promise((resolve) => setTimeout(resolve, 300));
        const visibleAfterRestore = target.isVisible();
        target.setPosition(originalBounds.x, originalBounds.y);
        await new Promise((resolve) => setTimeout(resolve, 350));
        const positionKept =
          Math.abs(movedBounds.x - desired.x) <= 1 &&
          Math.abs(movedBounds.y - desired.y) <= 1 &&
          Math.abs(reShownBounds.x - desired.x) <= 1 &&
          Math.abs(reShownBounds.y - desired.y) <= 1;
        const result = {
          ok:
            probe.api === 'object' &&
            probe.ready === true &&
            probe.time === '12:34' &&
            probe.status === 'Grabando' &&
            probe.micOn === true &&
            probe.pauseDisabled === false &&
            probe.stopDisabled === false &&
            pausedProbe.status === 'Pausada' &&
            pausedProbe.micOn === false &&
            pausedProbe.playIcon === true &&
            visibleWhileMinimized === true &&
            visibleAfterRestore === true &&
            positionKept === true,
          probe,
          pausedProbe,
          visibleWhileMinimized,
          visibleAfterRestore,
          positionKept,
          desired,
          movedBounds,
          reShownBounds,
          console: miniConsole,
        };
        await fsp.writeFile(
          path.join(process.cwd(), 'floating-test.log'),
          `${JSON.stringify(result, null, 2)}\n`,
          'utf8',
        );
        app.exit(result.ok ? 0 : 1);
      } catch (err) {
        await fsp
          .writeFile(
            path.join(process.cwd(), 'floating-test.log'),
            `${JSON.stringify({ ok: false, error: err?.stack || String(err) }, null, 2)}\n`,
            'utf8',
          )
          .catch(() => {});
        app.exit(1);
      }
    }, 1200);
  }

  if (TUTORIAL_TEST) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const result = await win.webContents.executeJavaScript(
            `(async () => {
              const info = await api.info();
              setProfile('tutorial');
              await new Promise((r) => setTimeout(r, 3500));
              const setup = {
                profile: state.settings.profile,
                quality: state.settings.quality,
                fps: state.settings.fps,
                countdown: state.settings.countdown,
                sourceType: state.source ? state.source.type : null,
                sourcePrimary: state.source ? Boolean(state.source.primary) : false,
                crop: state.crop ? { ...state.crop } : null,
                cropLabel: document.getElementById('cropLabel').textContent,
                switchActive: document.querySelector('#modeSwitch button.active')?.dataset.mode,
                hint: document.getElementById('recordHint').textContent,
              };
              const bounds = info.primaryDisplay.bounds;
              const work = info.primaryDisplay.workArea;
              const fullRatio = bounds.height / bounds.width;
              const workRatio = work.height / work.width;
              const taskbarPx = bounds.height - work.height;

              state.settings.micMode = 'off';
              state.settings.systemAudio = true;
              state.settings.autoLibrary = false;
              await startRecording();
              await new Promise((r) => setTimeout(r, 1500));
              const during = {
                recording: state.recording,
                width: state.width,
                height: state.height,
                ratio: state.height / state.width,
                title: state.recordingTitle,
                crop: state.crop ? { ...state.crop } : null,
              };
              stopRecording();
              for (let i = 0; i < 80; i += 1) {
                if (!state.recording && !state.saving) break;
                await new Promise((r) => setTimeout(r, 100));
              }
              await new Promise((r) => setTimeout(r, 600));
              const item = state.library.find((entry) => entry.title === during.title);
              const probe = item ? await probeVideoFile(item.videoUrl) : null;
              const saved = probe && item
                ? { width: probe.width, height: probe.height, duration: probe.duration, size: item.size }
                : null;

              const afterSave = {
                chipSourceDisabled: document.getElementById('chipSource').disabled,
                btnPickDisabled: document.getElementById('btnPick').disabled,
                modeSwitchDisabled: [...document.querySelectorAll('#modeSwitch button')].map(
                  (btn) => btn.disabled,
                ),
              };

              setProfile('class');
              await new Promise((r) => setTimeout(r, 400));
              const back = {
                profile: state.settings.profile,
                quality: state.settings.quality,
                fps: state.settings.fps,
                countdown: state.settings.countdown,
                crop: state.crop,
                cropLabel: document.getElementById('cropLabel').textContent,
                switchActive: document.querySelector('#modeSwitch button.active')?.dataset.mode,
              };

              return {
                setup,
                during,
                saved,
                afterSave,
                back,
                fullRatio,
                workRatio,
                taskbarPx,
                ok:
                  setup.profile === 'tutorial' &&
                  setup.quality === '720' &&
                  setup.fps === 30 &&
                  setup.countdown === 0 &&
                  setup.sourceType === 'screen' &&
                  setup.sourcePrimary === true &&
                  setup.crop === null &&
                  setup.switchActive === 'tutorial' &&
                  setup.cropLabel.indexOf('Pantalla completa') >= 0 &&
                  during.recording === true &&
                  Math.abs(during.ratio - fullRatio) < 0.012 &&
                  /^Tutorial /.test(during.title) &&
                  Boolean(saved) &&
                  saved.width === during.width &&
                  saved.height === during.height &&
                  saved.size > 0 &&
                  afterSave.chipSourceDisabled === false &&
                  afterSave.btnPickDisabled === false &&
                  afterSave.modeSwitchDisabled.every((disabled) => disabled === false) &&
                  back.profile === 'class' &&
                  back.crop === null &&
                  back.switchActive === 'class' &&
                  back.cropLabel.indexOf('Pantalla completa') < 0,
              };
            })()`,
            true,
          );
          await fsp.writeFile(
            path.join(process.cwd(), 'tutorial-test.log'),
            `${JSON.stringify(result, null, 2)}\n`,
            'utf8',
          );
          try {
            const image = await win.webContents.capturePage();
            await fsp.writeFile(path.join(process.cwd(), 'tutorial-test.png'), image.toPNG());
          } catch {
            /* captura opcional */
          }
          app.exit(result.ok ? 0 : 1);
        } catch (err) {
          await fsp
            .writeFile(
              path.join(process.cwd(), 'tutorial-test.log'),
              `${JSON.stringify({ ok: false, error: err?.stack || String(err) }, null, 2)}\n`,
              'utf8',
            )
            .catch(() => {});
          app.exit(1);
        }
      }, 2500);
    });
  }

  if (!SELF_TEST) {
    globalShortcut.register('CommandOrControl+Shift+R', () => {
      if (win && !win.isDestroyed()) win.webContents.send('shortcut:toggle-record');
    });
  } else {
    selfTestTimer = setTimeout(async () => {
      try {
        await fsp.mkdir(SELF_TEST_DIR, { recursive: true });
        await fsp.writeFile(
          path.join(SELF_TEST_DIR, 'self-test.log'),
          `${JSON.stringify({ ok: false, error: 'timeout' }, null, 2)}\n`,
          'utf8',
        );
      } catch {
        /* ignore */
      }
      app.exit(1);
    }, 60000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  stopMicHoldWatcher();
  closeFloatingWindow();
  globalShortcut.unregisterAll();
});
