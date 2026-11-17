// The page's few behaviours: the theme switch, tabs, copy buttons and the
// decision card. Everything works without it except these.
(function () {
  "use strict";
  var root = document.documentElement;
  var KEY = "quadit-site-theme";

  // Theme: the system's until the visitor picks one; the pick is remembered.
  var toggle = document.querySelector(".theme");
  var systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  function isDark() {
    return root.dataset.theme ? root.dataset.theme === "dark" : systemDark.matches;
  }
  function showTheme() {
    if (!toggle) return;
    var dark = isDark();
    toggle.setAttribute("aria-pressed", String(dark));
    toggle.setAttribute("aria-label", "Dark theme");
  }
  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = isDark() ? "light" : "dark";
      root.dataset.theme = next;
      try { localStorage.setItem(KEY, next); } catch (e) {}
      showTheme();
    });
    systemDark.addEventListener("change", showTheme);
    showTheme();
  }

  // Tabs, in the WAI-ARIA pattern: arrows, Home and End move between them.
  document.querySelectorAll("[data-tabs]").forEach(function (box) {
    var tabs = Array.prototype.slice.call(box.querySelectorAll('[role="tab"]'));
    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
      });
      if (focus) tab.focus();
      focusable();
    }
    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () { select(tab, false); });
      tab.addEventListener("keydown", function (e) {
        var to = null;
        if (e.key === "ArrowRight") to = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft") to = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") to = tabs[0];
        else if (e.key === "End") to = tabs[tabs.length - 1];
        if (to) { e.preventDefault(); select(to, true); }
      });
    });
  });

  // Code that runs off the side can be scrolled from the keyboard too.
  var scrollers = document.querySelectorAll("pre");
  function focusable() {
    scrollers.forEach(function (el) {
      if (el.scrollWidth > el.clientWidth + 1) el.tabIndex = 0;
      else el.removeAttribute("tabindex");
    });
  }
  focusable();
  window.addEventListener("resize", focusable);

  // Copy: the command beside the button, then "Copied" for a moment.
  document.querySelectorAll(".copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var code = btn.parentElement.querySelector("code");
      var text = code ? code.textContent.trim() : "";
      function done(ok) {
        btn.textContent = ok ? "Copied" : "Select";
        if (ok) btn.setAttribute("data-done", "");
        setTimeout(function () { btn.textContent = "Copy"; btn.removeAttribute("data-done"); }, 1600);
        if (!ok && code) {
          var range = document.createRange();
          range.selectNodeContents(code);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      } else {
        done(false);
      }
    });
  });

  // The decision card: a pick prints the lines the feed would carry.
  var card = document.querySelector("[data-decision]");
  if (card) {
    var feed = card.querySelector(".feed code");
    var again = card.querySelector(".again");
    var hint = card.querySelector(".q-hint");
    var state = card.querySelector(".q-state");
    var options = Array.prototype.slice.call(card.querySelectorAll(".opt"));
    var question = card.querySelector("#q-title").textContent;
    function stamp() {
      var d = new Date();
      function two(n) { return (n < 10 ? "0" : "") + n; }
      return two(d.getMonth() + 1) + "-" + two(d.getDate()) + " " + two(d.getHours()) + ":" + two(d.getMinutes());
    }
    function line(text) {
      var span = document.createElement("span");
      span.className = "line";
      span.textContent = text;
      return span;
    }
    options.forEach(function (opt) {
      opt.querySelector(".pick").addEventListener("click", function () {
        var n = opt.getAttribute("data-n");
        var label = opt.getAttribute("data-label");
        var when = stamp();
        card.setAttribute("data-picked", "");
        options.forEach(function (o) {
          var chosen = o === opt;
          if (chosen) o.setAttribute("data-chosen", ""); else o.removeAttribute("data-chosen");
          var b = o.querySelector(".pick");
          b.disabled = true;
          b.textContent = chosen ? "Picked" : "This one";
        });
        feed.textContent = "";
        feed.appendChild(line("#167 " + when + " @maya decision.picked TDW-1 \"" + question + "\" -> " + n + ") " + label + "\n"));
        feed.appendChild(line("#168 " + when + " @maya inbox picked: TDW-1 App icon for 2.0 — " + label));
        state.textContent = "Answered";
        hint.textContent = "Iris’s quadit listen gets the second line and wakes her.";
        again.hidden = false;
        again.focus();
      });
    });
    again.addEventListener("click", function () {
      card.removeAttribute("data-picked");
      options.forEach(function (o) {
        o.removeAttribute("data-chosen");
        var b = o.querySelector(".pick");
        b.disabled = false;
        b.textContent = "This one";
      });
      feed.textContent = "";
      state.textContent = "Your answer is needed";
      hint.textContent = "Try it: pick one, and see what reaches the agent.";
      again.hidden = true;
      options[0].querySelector(".pick").focus();
    });
  }
})();
