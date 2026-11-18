// Sets the theme before the first paint so the page never flashes, and keeps
// the browser's own chrome (the status bar of the installed app) in the same
// colour. A file of its own, not inline, so a strict Content-Security-Policy
// lets it run.
(function () {
  var root = document.documentElement;
  var colors = { light: "#ffffff", dark: "#1b1d23" };
  try {
    var t = localStorage.getItem("quadit.theme");
    if (t === "system") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    else if (t !== "light") t = "dark";
    root.dataset.theme = t;
  } catch {
    root.dataset.theme = "dark";
  }
  function paint() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", colors[root.dataset.theme] || colors.dark);
  }
  paint();
  try {
    new MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  } catch {}
})();
