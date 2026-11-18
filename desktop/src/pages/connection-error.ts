// The page over a server's window whose page could not be loaded
// (src/main/connection-error.ts). Its address carries what it says:
// connection-error.html?name=…&origin=…&reason=…

import type { PagesApi } from "@/shared/pages-api";

const api = window.quaditPages as PagesApi;
const said = new URLSearchParams(location.search);
const text = (id: string, value: string) => {
  const found = document.getElementById(id);
  if (found) found.textContent = value;
};

text("title", `${said.get("name") ?? "The server"} cannot be reached`);
text("origin", said.get("origin") ?? "");
text("reason", said.get("reason") ?? "");
document.title = `${said.get("name") ?? "The server"} cannot be reached`;
document.getElementById("retry")?.addEventListener("click", () => api.retryServer());
// The network is back: no need to wait for the next try.
addEventListener("online", () => api.retryServer());
