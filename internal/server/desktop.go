package server

// The desktop app: signing it in through the system browser.

// desktopHandoff is the version of the sign-in hand-off this server speaks
// to the desktop app; GET /api/v1/version says it, so an app can tell a
// server too old or too new for it.
const desktopHandoff = 1
