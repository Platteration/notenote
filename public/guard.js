/* The Daily Scroll: the safety net.
 *
 * Loaded first in every page's <head>, on its own and depending on nothing, so that when the
 * app's scripts fail to arrive (a dropped connection, a proxy or extension that blocks them, a
 * policy that refuses them) or throw before the app has started, the visitor reads a short note
 * saying so instead of pressing buttons that do nothing. The pages are drawn on the server, so
 * without this a page that never started looks exactly like one that did.
 *
 * The app calls dailyScrollGuard.started() once React has taken over the page (the Started
 * component in the root layout). From then on a failure is the app's to report, and a script
 * the framework fetches later is the framework's to retry, so the note is only ever about
 * starting — and a note shown to a page that then starts after all is taken down again.
 *
 * Two ways in, because the framework's scripts are async and come first in the <head>: one can
 * fail, or throw, before this file has even arrived. The listener below catches what happens
 * after it; the check after `load` (which waits for every async script) catches the rest, as a
 * page that has had all of its scripts and still has not started.
 */
(function () {
  "use strict";

  var started = false;
  var shown = null;
  // After `load`, how long a page may take to start before the note goes up. Hydrating any page
  // here takes well under a second; the note comes down again if the page starts after all.
  var GRACE_MS = 4000;
  var NOTE =
    "The Daily Scroll didn't finish loading, so its buttons won't respond. Check your connection, then reload the page.";

  function own(url) {
    return typeof url === "string" && url.indexOf(location.origin + "/") === 0;
  }

  function place(note) {
    // At the top of the page, so it reads first even if the stylesheet is what failed.
    document.body.insertBefore(note, document.body.firstChild);
  }

  function show() {
    if (started || shown) return;
    var note = document.createElement("div");
    note.className = "boot-note";
    note.setAttribute("role", "alert");
    note.appendChild(document.createTextNode(NOTE + " "));
    var reload = document.createElement("button");
    reload.type = "button";
    reload.className = "btn btn-sm";
    reload.textContent = "Reload";
    reload.addEventListener("click", function () {
      location.reload();
    });
    note.appendChild(reload);
    shown = note;
    if (document.body) place(note);
    else document.addEventListener("DOMContentLoaded", function () { place(note); });
  }

  // Capture phase: a script or stylesheet that fails to load fires `error` on its element, which
  // does not bubble. A script the policy refuses fires it too.
  window.addEventListener(
    "error",
    function (event) {
      var el = event.target;
      if (el && el !== window && el.tagName) {
        var tag = el.tagName.toLowerCase();
        if ((tag === "script" && own(el.src)) || (tag === "link" && el.rel === "stylesheet" && own(el.href))) show();
        return;
      }
      // An exception thrown by one of the app's own scripts before it started. Errors from
      // elsewhere (a browser extension's content script) are not the app failing to start.
      if (own(event.filename)) show();
    },
    true,
  );

  window.addEventListener("load", function () {
    setTimeout(show, GRACE_MS);
  });

  window.dailyScrollGuard = {
    started: function () {
      started = true;
      if (shown && shown.parentNode) shown.parentNode.removeChild(shown);
    },
  };
})();
