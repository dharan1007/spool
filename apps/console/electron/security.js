// Window and webContents hardening. The renderer loads only the bundled
// application; navigation, new windows and devtools-mediated access to disk
// are denied. Permission requests are refused by default.
const ALLOWED_PERMISSIONS = new Set([]);

export function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://") || !url.includes("/dist/renderer/")) event.preventDefault();
  });
  win.webContents.on("will-attach-webview", event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  win.webContents.session.setPermissionCheckHandler(() => false);
}

export function setContentSecurityPolicy(win) {
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
        ]
      }
    });
  });
}
