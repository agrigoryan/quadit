// The page's few behaviours: the field behind the hero, tabs, copy buttons
// and the decision card. Everything works without it except these.
(function () {
  "use strict";
  // The field behind the hero: the icon's squares as a floor in perspective,
  // drifting towards the visitor. Tiles glow in slow waves and near the
  // pointer, and now and then one turns the yellow of "your move". Drawn on
  // one canvas; still when motion is not wanted, and asleep off screen.
  var canvas = document.querySelector(".field");
  if (canvas && canvas.getContext) {
    var ctx = canvas.getContext("2d");
    var still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var w = 0, h = 0, horizon = 0, near = 2.2, focal = 0, lift = 0;
    var pointer = null, moves = [], lastMove = 0, last = 0, running = false;

    function size() {
      var box = canvas.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = box.width; h = box.height;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      horizon = h * 0.05;
      focal = Math.max(110, Math.min(170, w / 9)) * near; // a tile at the front edge is about this wide
      lift = (h - horizon) * near;                        // puts the front row on the bottom edge
    }
    // A number in 0..1 that stays the same for a tile.
    function seed(i, k) {
      var n = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
      return n - Math.floor(n);
    }
    function draw(t) {
      ctx.clearRect(0, 0, w, h);
      var drift = t * 0.11, row0 = Math.floor(drift), frac = drift - row0;
      for (var r = 0; r < 26; r++) {
        var z0 = near + r - frac, z1 = z0 + 1;
        if (z0 < 0.6) continue;
        var yNear = horizon + lift / z0, yFar = horizon + lift / z1;
        if (yFar > h) continue;
        var depth = Math.min(1, (yFar - horizon) / (h * 0.22)); // fades into the horizon
        var half = Math.ceil(((w / 2) * z1) / focal) + 1, k = r + row0;
        for (var i = -half; i < half; i++) {
          var g = 0.07, xa = i + g, xb = i + 1 - g;
          var za = z0 + g, zb = z1 - g;
          var ya = horizon + lift / za, yb = horizon + lift / zb;
          var x1 = w / 2 + (focal * xa) / za, x2 = w / 2 + (focal * xb) / za;
          var x3 = w / 2 + (focal * xb) / zb, x4 = w / 2 + (focal * xa) / zb;
          var wave = Math.sin(i * 0.33 + t * 0.5) * Math.sin(k * 0.41 - t * 0.37) + Math.sin((i + k) * 0.19 + t * 0.23);
          var glow = Math.pow(Math.max(0, wave - 0.55), 2) * 0.2;
          var s = seed(i, k);
          glow += Math.pow(Math.max(0, Math.sin(t * (0.5 + s) + s * 40)), 10) * 0.2;
          if (pointer) {
            var dx = (x1 + x3) / 2 - pointer.x, dy = (ya + yb) / 2 - pointer.y;
            glow += Math.pow(Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 230), 2) * 0.4;
          }
          var move = 0;
          for (var m = 0; m < moves.length; m++) {
            if (moves[m].i === i && moves[m].k === k) move = Math.sin(Math.PI * Math.min(1, (t - moves[m].at) / moves[m].for));
          }
          ctx.beginPath();
          ctx.moveTo(x1, ya); ctx.lineTo(x2, ya); ctx.lineTo(x3, yb); ctx.lineTo(x4, yb); ctx.closePath();
          if (move > 0) {
            ctx.fillStyle = "rgba(255,214,10," + (0.9 * move * depth).toFixed(3) + ")";
            ctx.fill();
          } else if (glow > 0.004) {
            ctx.fillStyle = (s > 0.5 ? "rgba(122,140,255," : "rgba(160,120,255,") + (glow * depth).toFixed(3) + ")";
            ctx.fill();
          }
          ctx.strokeStyle = "rgba(170,182,255," + ((0.075 + glow * 0.5) * depth).toFixed(3) + ")";
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        if (yNear < 0) break;
      }
    }
    // Every so often a tile somewhere in the middle becomes somebody's move.
    function askSomeone(t) {
      moves = moves.filter(function (m) { return t - m.at < m.for; });
      if (t - lastMove < 1.4 || moves.length >= 3) return;
      lastMove = t;
      // Not behind the words: a tile is tried a few times until it lands clear of them.
      for (var tries = 0; tries < 8; tries++) {
        var ahead = 1 + Math.floor(Math.random() * 12), i = Math.floor(Math.random() * 18) - 9;
        var z = near + ahead + 0.5, x = w / 2 + (focal * (i + 0.5)) / z, y = horizon + lift / z;
        if (Math.abs(x - w / 2) < 480 && y > 150 && y < 720) continue;
        moves.push({ i: i, k: Math.floor(t * 0.11) + ahead, at: t, for: 3 + Math.random() * 2 });
        return;
      }
    }
    function frame(now) {
      if (!running) return;
      requestAnimationFrame(frame);
      if (now - last < 30) return;
      last = now;
      var t = now / 1000;
      askSomeone(t);
      draw(t);
    }
    function wake(on) {
      if (still) return;
      if (on && !running) { running = true; requestAnimationFrame(frame); }
      else if (!on) running = false;
    }
    size();
    if (still) {
      moves = [{ i: 2, k: 6, at: 0, for: 2 }, { i: -4, k: 9, at: 0, for: 2 }];
      draw(1);
    }
    window.addEventListener("resize", function () { size(); if (still) draw(1); });
    window.addEventListener("pointermove", function (e) {
      var box = canvas.getBoundingClientRect();
      pointer = e.clientY < box.bottom ? { x: e.clientX - box.left, y: e.clientY - box.top } : null;
    }, { passive: true });
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (seen) { wake(seen[0].isIntersecting && !document.hidden); }).observe(canvas);
    } else {
      wake(true);
    }
    document.addEventListener("visibilitychange", function () { wake(!document.hidden && canvas.getBoundingClientRect().bottom > 0); });
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
