// Downloading a file the server makes (an export, a CSV, a backup).

/** Starts a download of a same-origin address (an export, a CSV, a backup). */
export function download(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
