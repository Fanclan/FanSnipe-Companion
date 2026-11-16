const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell, utilityProcess } = require('electron');
const path = require('node:path');
const { isDashboardUrl, verifyResources, parseTestEnvironment } = require('./security.cjs');
const testEnvironment = parseTestEnvironment(process.env);
if (testEnvironment) app.setPath('userData', testEnvironment.dataDir);
const config = require('./config.json');
function openAllowedExternal(target) { try { const u = new URL(target); if (u.protocol === 'https:' && !u.username && !u.password && [...config.externalOrigins, ...config.dashboardOrigins].includes(u.origin)) void shell.openExternal(u.href); } catch {} }
const PORT = 47821;
let window, tray, engine, quitting = false, engineReady = false, showingPairing = false, showingUploadApproval = false, timer;
const declinedPairings = new Set();
const url = `http://127.0.0.1:${PORT}/app/`;
function showWindow() { if (!window || window.isDestroyed()) createWindow(); else { window.show(); window.focus(); } }
function createWindow() {
  window = new BrowserWindow({ width: 1280, height: 820, minWidth: 800, minHeight: 600, show: false, title: 'StreamSnipe', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.setWindowOpenHandler(({url: target}) => { openAllowedExternal(target); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, target) => { if (!isDashboardUrl(target, PORT)) { event.preventDefault(); openAllowedExternal(target); } });
  window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.once('ready-to-show', () => window.show());
  window.loadURL(url).catch(error => dialog.showErrorBox('StreamSnipe dashboard', String(error)));
}
async function handlePairings(pairings) {
  if (showingPairing || showingUploadApproval || !Array.isArray(pairings)) return;
  for (const id of declinedPairings) if (!pairings.some(p => p.id === id)) declinedPairings.delete(id);
  const p = pairings.find(p => !declinedPairings.has(p.id));
  if (!p) return;
  showingPairing = true;
  try {
    const result = await dialog.showMessageBox({type:'question', title:'Approve browser pairing', message:`Approve ${String(p.name || 'browser')}?`, detail:`Confirm this code matches the browser: ${String(p.code || '')}`, buttons:['Approve', 'Cancel'], defaultId:1, cancelId:1, noLink:true});
    if (result.response === 0) engine.postMessage({type:'approve', id:p.id});
    else declinedPairings.add(p.id);
  } finally { showingPairing = false; }
}
async function handleUploadApprovals(approvals) {
  if (showingPairing || showingUploadApproval || !Array.isArray(approvals) || !approvals.length) return;
  const approval = approvals[0];
  const destination = approval.destination || {};
  showingUploadApproval = true;
  try {
    const result = await dialog.showMessageBox({
      type: 'question', title: 'Approve your upload destination',
      message: destination.s3Enabled ? 'Allow direct uploads to this destination?' : 'Disable direct uploads?',
      detail: `Bucket: ${String(destination.s3Bucket || '(none)')}\nRegion: ${String(destination.s3Region || '(default)')}\nEndpoint: ${String(destination.s3Endpoint || 'Amazon S3')}\n\nOnly approve a storage destination you control. Recordings go directly from this computer to that destination.`,
      buttons: ['Approve', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    });
    engine.postMessage({type: 'resolve-upload-approval', id: approval.id, approved: result.response === 0});
  } finally { showingUploadApproval = false; }
}
function buildMenu() {
  const login = app.getLoginItemSettings().openAtLogin;
  return Menu.buildFromTemplate([
    {label:'Open StreamSnipe', click:showWindow},
    {label:'Choose recording folder…', click: async () => { const result = await dialog.showOpenDialog({title:'Choose recording folder', properties:['openDirectory','createDirectory']}); if (!result.canceled && result.filePaths[0]) engine.postMessage({type:'folder', path:result.filePaths[0]}); }},
    {label:'Import legacy database…', click: async () => {
      const result = await dialog.showOpenDialog({title:'Select legacy StreamSnipe database', properties:['openFile'], filters:[{name:'SQLite databases', extensions:['db','sqlite','sqlite3']}]});
      if (result.canceled || !result.filePaths[0]) return;
      const media = await dialog.showOpenDialog({title:'Select the original recordings folder to link existing media', buttonLabel:'Use recordings folder', properties:['openDirectory']});
      if (media.canceled || !media.filePaths[0]) return;
      engine.postMessage({type:'import', path:result.filePaths[0], mediaRoot:media.filePaths[0]});
    }},
    {label:'Show diagnostics', click: () => engine.postMessage({type:'diagnostics'})},
    {label:'Launch at login', type:'checkbox', checked:login, click:item => { app.setLoginItemSettings({openAtLogin:item.checked}); tray.setContextMenu(buildMenu()); }},
    {type:'separator'}, {label:'Quit StreamSnipe', click:()=>app.quit()}
  ]);
}
app.whenReady().then(() => {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  app.on('second-instance', showWindow);
  const resources = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../staging');
  try { verifyResources(resources); } catch (error) { dialog.showErrorBox('StreamSnipe integrity check', String(error)); app.quit(); return; }
  engine = utilityProcess.fork(path.join(__dirname, 'engine.cjs'), [], {serviceName:'StreamSnipe engine'});
  engine.on('message', message => {
    if (message.type === 'ready') { engineReady = true; createWindow(); timer = setInterval(() => engine.postMessage({type:'pending'}), 3000); }
    if (message.type === 'pending') void handlePairings(message.pairings);
    if (message.type === 'upload-approvals') void handleUploadApprovals(message.approvals);
    if (message.type === 'imported') void dialog.showMessageBox({title:'Legacy import', message:'Import finished', detail:JSON.stringify(message.data), buttons:['Close']});
    if (message.type === 'diagnostics') void dialog.showMessageBox({title:'StreamSnipe diagnostics', message:'Local diagnostics', detail:JSON.stringify(message.data, null, 2), buttons:['Close']});
    if (message.type === 'error') dialog.showErrorBox('StreamSnipe engine', message.message);
    if (message.type === 'stopped') { engineReady = false; app.quit(); }
  });
  engine.on('exit', () => { engineReady = false; if (!quitting) dialog.showErrorBox('StreamSnipe engine', 'The recording engine stopped unexpectedly. Restart StreamSnipe.'); });
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')));
  tray.setToolTip('StreamSnipe'); tray.setContextMenu(buildMenu()); tray.on('click', showWindow);
  engine.postMessage({type:'start', resources, fixtureOrigin:testEnvironment?.origin, dataDir:app.getPath('userData'), recordingsPath:testEnvironment ? path.join(testEnvironment.dataDir, 'recordings') : (process.env.STREAMSNIPE_RECORDINGS_PATH || path.join(app.getPath('videos'), 'StreamSnipe'))});
});
app.on('before-quit', event => { if (!quitting && engineReady) { event.preventDefault(); quitting = true; clearInterval(timer); engine.postMessage({type:'stop'}); } });
app.on('window-all-closed', () => {});
app.on('activate', showWindow);
