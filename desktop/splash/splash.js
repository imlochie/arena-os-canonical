/** Splash runtime: renders real bridge info — or says honestly that there is none. */
(function () {
  "use strict";

  var el = function (id) {
    return document.getElementById(id);
  };

  function render(info) {
    el("version").textContent =
      "Arena " + info.version + " · Electron " + info.electron;
    el("platform").textContent =
      info.platform + " " + info.arch + (info.portable ? " · portable" : "");
    el("data").textContent = info.dataDir;
    el("status").textContent = "Desktop shell ready";
  }

  function fail(message) {
    el("status").textContent = message;
  }

  if (typeof window.arenaDesktop === "object" && window.arenaDesktop) {
    window.arenaDesktop
      .getInfo()
      .then(render)
      .catch(function (error) {
        fail("Bridge error: " + error);
      });
  } else {
    fail("No desktop bridge — this page is running outside the Arena shell");
  }
})();
