// The bar over a server's sign-in page that starts the browser sign-in.
// Its address names the server: sign-in-bar.html?server=<id>.

import type { PagesApi } from "@/shared/pages-api";

const api = window.quaditPages as PagesApi;
const serverId = new URLSearchParams(location.search).get("server") ?? "";

document.getElementById("sign-in")?.addEventListener("click", () => void api.signIn(serverId));
document.getElementById("dismiss")?.addEventListener("click", () => api.dismissSignInBar());
