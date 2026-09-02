import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { installReticleCapture } from '@reticlehq/electron/main'
import icon from '../../resources/icon.png?asset'

/**
 * Headless mode for CI. An Electron "headless" app is a window that is never shown: the renderer
 * still runs, still executes JS, and still connects to the Reticle bridge. `backgroundThrottling:
 * false` is load-bearing — Chromium throttles timers in a hidden window, which turns every settle
 * wait into a flake.
 */
const HEADLESS = process.env['RETICLE_HEADLESS'] === '1'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: !HEADLESS,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false
    }
  })
  installReticleCapture(mainWindow)

  // A desktop renderer has no visible console unless you open DevTools, so a Reticle connect
  // failure would otherwise be completely silent in the desktop spec log.
  mainWindow.webContents.on('console-message', (...args) => {
    const details = args[0]
    const message =
      details !== null && typeof details === 'object' && 'message' in details
        ? details.message
        : args[2]
    console.log(`[renderer] ${String(message)}`)
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.log(`[renderer] LOAD FAILED ${String(code)} ${description} ${url}`)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    console.log(`[renderer] loaded ${mainWindow.webContents.getURL()}`)
  })

  mainWindow.on('ready-to-show', () => {
    if (!HEADLESS) mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('ping', () => console.log('pong'))

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
