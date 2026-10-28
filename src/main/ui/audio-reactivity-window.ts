import { BrowserWindow, desktopCapturer, ipcMain, screen, session, type IpcMainEvent, type Session } from 'electron'
import { IPC } from '@shared/ipc'
import type { Log } from '../logger'
import { harden, loadPage, secureWebPreferences } from './windows'

const WIDTH = 440
const HEIGHT = 360

export interface AudioReactivityDeps {
  log: Log
  iconPath: string
  onBeat: (strength: number) => void
}

/** User-controlled, local-only Windows system-audio analysis. Closing this panel ends capture. */
export class AudioReactivityWindow {
  private win: BrowserWindow | null = null
  private readonly captureSession: Session

  constructor(private readonly deps: AudioReactivityDeps) {
    this.captureSession = session.fromPartition('audio-reactivity')
    this.captureSession.setDisplayMediaRequestHandler((_request, callback) => {
      void desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const source = sources[0]
          if (!source) {
            callback({})
            return
          }
          // Video is required by Chromium's display-media request; the renderer immediately
          // stops that track and consumes only Windows' supported system loopback audio.
          callback({ video: source, audio: 'loopback' })
        })
        .catch((error: unknown) => {
          this.deps.log(`audio: could not initialize Windows loopback (${String(error)})`)
          callback({})
        })
    })
    ipcMain.on(IPC.audioBeat, this.onBeat)
  }

  open(): void {
    if (process.platform !== 'win32') {
      this.deps.log('audio: live system loopback is available only on Windows')
      return
    }
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore()
      this.win.show()
      this.win.focus()
      return
    }
    const area = screen.getPrimaryDisplay().workArea
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      useContentSize: true,
      x: area.x + Math.round((area.width - WIDTH) / 2),
      y: area.y + Math.round((area.height - HEIGHT) / 2),
      show: false,
      resizable: false,
      maximizable: false,
      minimizable: true,
      title: 'Live Audio Lighting',
      icon: this.deps.iconPath,
      backgroundColor: '#0c0b10',
      autoHideMenuBar: true,
      webPreferences: secureWebPreferences({ partition: 'audio-reactivity' })
    })
    win.removeMenu()
    harden(win)
    win.once('ready-to-show', () => win.show())
    win.on('closed', () => {
      if (this.win === win) this.win = null
      this.deps.onBeat(0)
    })
    this.win = win
    loadPage(win, 'audio').catch((error: unknown) => this.deps.log(`audio: setup page failed (${String(error)})`))
  }

  destroy(): void {
    ipcMain.removeListener(IPC.audioBeat, this.onBeat)
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    this.deps.onBeat(0)
  }

  private readonly onBeat = (event: IpcMainEvent, value: unknown): void => {
    if (!this.win || this.win.isDestroyed() || event.sender !== this.win.webContents) return
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    this.deps.onBeat(Math.max(0, Math.min(1, value)))
  }
}
