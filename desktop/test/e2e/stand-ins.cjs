// Loaded into the app's main process before the app's own code runs
// (electron -r, see desktop.ts), so that what the app does from
// its first moment, a notice at start among it, is recorded and nothing
// leaves the test:
//
//   shell.openExternal          records the address instead of opening the system browser
//   Notification.prototype.show records the notification instead of showing it
//   dialog.showMessageBox       records the message and answers with its cancel button
//
// What was recorded is globalThis.e2e, which the tests read back.

const { dialog, Notification, shell } = require("electron");

const recorded = { opened: [], notes: [], dialogs: [] };
globalThis.e2e = recorded;

shell.openExternal = async (url) => void recorded.opened.push(url);
Notification.prototype.show = function show() {
  recorded.notes.push(this);
};
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  recorded.dialogs.push(`${options.message} ${options.detail ?? ""}`.trim());
  return { response: options.cancelId ?? 0, checkboxChecked: false };
};
