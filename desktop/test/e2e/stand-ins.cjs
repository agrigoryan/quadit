// Loaded into the app's main process before the app's own code runs
// (electron -r, see desktop.ts), so that what the app does from
// its first moment, a notice at start among it, is recorded and nothing
// leaves the test:
//
//   shell.openExternal          records the address instead of opening the system browser
//   Notification.prototype.show records the notification instead of showing it
//   dialog.showMessageBox       records the message and answers with its cancel button, or with the
//   dialog.showMessageBoxSync   button a test asked for (e2e.answers, first in first out)
//   dialog.showOpenDialog       the folder picker: answers with the folder a test gave (e2e.folders,
//                               first in first out), else as cancelled
//   app.setBadgeCount           records the count (macOS shows a badge only once the app may
//                               notify, which a test cannot wait for, so the system's own is unreliable)
//
// An exception the main process does not catch is recorded too, instead of
// Electron's dialog about it, which would stop the app until someone closes
// it: every test fails on one (desktop.ts, close).
//
// What was recorded is globalThis.e2e, which the tests read back.

const { app, dialog, nativeTheme, Notification, shell } = require("electron");

// The windows a run opens on the screen are dark, whatever the system's setting.
nativeTheme.themeSource = "dark";

const recorded = { opened: [], notes: [], dialogs: [], answers: [], folders: [], badge: 0, errors: [] };
globalThis.e2e = recorded;
process.on("uncaughtException", (err) => recorded.errors.push(String(err?.stack ?? err)));

shell.openExternal = async (url) => void recorded.opened.push(url);
Notification.prototype.show = function show() {
  recorded.notes.push(this);
};
app.setBadgeCount = (count = 0) => {
  recorded.badge = count;
  return true;
};
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  recorded.dialogs.push(`${options.message} ${options.detail ?? ""}`.trim());
  return { response: recorded.answers.shift() ?? options.cancelId ?? 0, checkboxChecked: false };
};
dialog.showMessageBoxSync = (...args) => {
  const options = args.at(-1);
  recorded.dialogs.push(`${options.message} ${options.detail ?? ""}`.trim());
  return recorded.answers.shift() ?? options.cancelId ?? 0;
};
dialog.showOpenDialog = async () => {
  const folder = recorded.folders.shift();
  return folder ? { canceled: false, filePaths: [folder] } : { canceled: true, filePaths: [] };
};
