// The page's few behaviours: the field behind the hero, tabs and copy
// buttons. Everything works without it except these.
(function () {
  "use strict";
  // The field behind the hero: a flat grid of small squares that flicker,
  // brighten in slow waves and under the pointer. Now and then four of them
  // light up as the icon does, three pale and one the yellow of "your move".
  // Drawn on one canvas; still when motion is not wanted, asleep off screen.
  var canvas = document.querySelector(".field");
  if (canvas && canvas.getContext) {
    var ctx = canvas.getContext("2d");
    var still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var PITCH = 28, DOT = 3;
    var w = 0, h = 0, cols = 0, rows = 0;
    var pointer = null, quads = [], lastQuad = 0, last = 0, running = false;

    function size() {
      var box = canvas.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = box.width; h = box.height;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / PITCH) + 1; rows = Math.ceil(h / PITCH) + 1;
    }
    // A number in 0..1 that stays the same for a square.
    function seed(i, k) {
      var n = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
      return n - Math.floor(n);
    }
    // How strongly the square (i, k) is part of a lit quad, and whether it is the yellow one.
    function quadAt(i, k, t) {
      for (var q = 0; q < quads.length; q++) {
        var di = i - quads[q].i, dk = k - quads[q].k;
        if (di < 0 || di > 1 || dk < 0 || dk > 1) continue;
        var lit = Math.sin(Math.PI * Math.min(1, (t - quads[q].at) / quads[q].for));
        return { lit: lit, yours: di === 1 && dk === 0 };
      }
      return null;
    }
    function draw(t) {
      ctx.clearRect(0, 0, w, h);
      var left = (w - (cols - 1) * PITCH) / 2;
      for (var k = 0; k < rows; k++) {
        for (var i = 0; i < cols; i++) {
          var x = left + i * PITCH, y = k * PITCH + 12, s = seed(i, k);
          var a = 0.13;
          a += Math.pow(Math.max(0, Math.sin(t * (0.6 + s * 1.6) + s * 50)), 14) * 0.55;         // its own flicker
          a += Math.pow(Math.max(0, Math.sin(i * 0.19 + k * 0.15 - t * 0.7)), 4) * 0.38;         // a wave passing
          if (pointer) {
            var dx = x - pointer.x, dy = y - pointer.y;
            a += Math.pow(Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / 190), 2) * 0.7;
          }
          var quad = quadAt(i, k, t), d = DOT;
          if (quad) {
            d = DOT + quad.lit * 8;
            ctx.fillStyle = quad.yours ? "rgba(255,214,10," + (0.15 + 0.85 * quad.lit).toFixed(3) + ")" : "rgba(226,231,255," + (a + 0.6 * quad.lit).toFixed(3) + ")";
          } else {
            ctx.fillStyle = (s > 0.6 ? "rgba(176,150,255," : "rgba(150,166,255,") + Math.min(0.95, a).toFixed(3) + ")";
          }
          ctx.fillRect(x - d / 2, y - d / 2, d, d);
        }
      }
    }
    // Every so often a quad lights up somewhere, clear of the words.
    function lightOne(t) {
      quads = quads.filter(function (q) { return t - q.at < q.for; });
      if (t - lastQuad < 1.1 || quads.length >= 4) return;
      lastQuad = t;
      for (var tries = 0; tries < 8; tries++) {
        var i = Math.floor(Math.random() * (cols - 2)), k = 1 + Math.floor(Math.random() * Math.min(rows - 3, 22));
        var x = (w - (cols - 1) * PITCH) / 2 + i * PITCH, y = k * PITCH;
        if (Math.abs(x - w / 2) < 470 && y > 110 && y < 680) continue;
        quads.push({ i: i, k: k, at: t, for: 2.6 + Math.random() * 2 });
        return;
      }
    }
    function frame(now) {
      if (!running) return;
      requestAnimationFrame(frame);
      if (now - last < 32) return;
      last = now;
      var t = now / 1000;
      lightOne(t);
      draw(t);
    }
    function wake(on) {
      if (still) return;
      if (on && !running) { running = true; requestAnimationFrame(frame); }
      else if (!on) running = false;
    }
    function rest() {
      quads = [{ i: Math.floor(cols * 0.14), k: 6, at: 0, for: 2 }, { i: Math.floor(cols * 0.84), k: 10, at: 0, for: 2 }];
      draw(1);
    }
    size();
    if (still) rest();
    window.addEventListener("resize", function () { size(); if (still) rest(); });
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

  // The download button is for the system this is read on: it takes the
  // address of that system's link in the row under it. A Mac stays as
  // written (Apple silicon; a browser cannot tell which Mac it is on), and a
  // phone or tablet, which cannot run the app, gets the list of all files.
  var main = document.getElementById("dl-main");
  if (main) {
    var system = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    var phone = /android|iphone|ipad|ipod/i.test(navigator.userAgent) || (/mac/i.test(system) && navigator.maxTouchPoints > 1);
    var os = /win/i.test(system) ? "win" : /linux|x11/i.test(system) && !phone ? "linux" : "";
    var link = os && document.querySelector('.dl-all a[data-os="' + os + '"]');
    var all = document.querySelector(".dl-all a[data-release]");
    if (phone && all) {
      // The app is for a computer: on a phone the button leads to all its files.
      main.href = all.href;
      main.textContent = "Get the desktop app";
    } else if (link) {
      main.href = link.href;
      main.textContent = "Download for " + link.textContent;
    }
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
  // The hero film: plays when most of it is in view, waits while it is off
  // screen, and goes round: its last frame stays a moment, then it starts
  // again. Visitors who ask for less motion or less data keep the poster and
  // the browser's controls, as the markup gives them.
  var film = document.querySelector(".hero-video");
  var calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    (navigator.connection && navigator.connection.saveData);
  if (film && !calm && "IntersectionObserver" in window) {
    var inView = false;
    var again = 0;
    function play() {
      var started = film.play();
      // A browser that refuses to play on its own (low power mode) shows the controls instead.
      if (started && started.catch) started.catch(function () { film.controls = true; });
    }
    film.muted = true;
    film.controls = false;
    film.preload = "auto";
    // 60% rather than all of it: the frame is taller than many laptop screens.
    new IntersectionObserver(function (entries) {
      inView = entries[0].isIntersecting;
      if (!inView) film.pause();
      else if (!film.ended) play();
      else if (!again) restart();
    }, { threshold: 0.6 }).observe(film);
    function restart() {
      again = 0;
      if (!inView) return;
      film.currentTime = 0;
      play();
    }
    // The finished task is worth a look before the film starts over.
    film.addEventListener("ended", function () { again = setTimeout(restart, 2500); });
  }
})();
