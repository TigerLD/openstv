// OpenSTV desktop: native Windows window that hosts the local OpenSTV interface.
//
// The user interface itself is the same local web app that `OpenSTV.exe` opens
// in a browser. Here it runs inside an Electron BrowserWindow, so OpenSTV looks
// and behaves like a normal Windows application: own window, own taskbar icon,
// no address bar, no tabs.
import { appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, Menu, dialog, screen, shell } from "electron";
import { startGui } from "../../exporter/src/gui.mjs";

const LOG_FILE = join(tmpdir(), "openstv-desktop.log");

function log(message) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {
    // logging must never break startup
  }
}

let mainWindow = null;
let localServer = null;

function createWindow(url) {
  // Fit the screen: on a 1280x800 laptop a 920px-tall window would hang off the
  // bottom edge.
  const area = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1320, Math.max(960, area.width - 60));
  const height = Math.min(920, Math.max(620, area.height - 60));

  const win = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(980, width),
    minHeight: Math.min(640, height),
    center: true,
    title: "OpenSTV",
    backgroundColor: "#f2f5f9",
    autoHideMenuBar: true,
    show: false,
    icon: join(__dirname, "icon.ico"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    mainWindow = null;
  });

  // Nothing outside the local interface should ever open in this window.
  win.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      if (/^https?:/i.test(target)) shell.openExternal(target);
    }
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });

  win.loadURL(url);
  return win;
}

async function boot() {
  const started = await startGui({
    port: 0,
    openBrowser: false,
    onQuit: () => app.quit(),
  });
  localServer = started.server;

  const port = new URL(started.url).port;
  // Diagnostics: lets tools (and the CLI) find the running instance.
  try {
    writeFileSync(join(tmpdir(), "openstv.port"), port, "utf8");
  } catch {
    // not critical
  }
  log(`server listening on ${port}`);

  mainWindow = createWindow(started.url);
  log("window created");
}

function showFatal(message) {
  log(`FATAL ${message}`);
  try {
    dialog.showErrorBox("OpenSTV", `Не удалось запустить приложение.\n\n${message}`);
  } catch {
    // dialog is not available before app is ready; nothing else to do
  }
}

log(`start: version=${app.getVersion()} electron=${process.versions.electron} pid=${process.pid}`);

// One instance only: a second double-click focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  log("another instance is running, exiting");
  // quit() alone can be ignored before the app is ready, so make sure we exit.
  app.quit();
  app.exit(0);
} else {
  app.setAppUserModelId("ru.openstv.app");

  app.on("second-instance", () => {
    log("second instance signal -> focusing window");
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    try {
      await boot();
    } catch (e) {
      showFatal(e?.stack ?? String(e));
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    log("window closed");
    app.quit();
  });

  app.on("before-quit", () => {
    if (localServer) {
      try {
        localServer.close();
      } catch {
        // already closed
      }
      localServer = null;
    }
  });

  process.on("uncaughtException", (e) => {
    log(`uncaught: ${e?.stack ?? e}`);
  });
}
