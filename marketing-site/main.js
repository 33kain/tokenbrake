// Nimbus — test marketing site. UI behavior only; no CTA is wired to a backend.
(function () {
  "use strict";

  // Mobile nav toggle
  var toggle = document.querySelector(".nav-toggle");
  var links = document.querySelector(".nav-links");
  if (toggle && links) {
    toggle.addEventListener("click", function () {
      links.classList.toggle("open");
      var open = links.classList.contains("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
  }

  // Pricing monthly / annual toggle
  var billing = document.querySelector(".billing-toggle");
  var grid = document.querySelector(".pricing-grid");
  if (billing && grid) {
    billing.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        billing.querySelectorAll("button").forEach(function (x) {
          x.classList.remove("active");
        });
        b.classList.add("active");
        grid.classList.toggle("pricing-annual", b.dataset.mode === "annual");
      });
    });
  }

  // Auth login / signup tabs
  var tabs = document.querySelector(".auth-tabs");
  if (tabs) {
    var loginPane = document.getElementById("pane-login");
    var signupPane = document.getElementById("pane-signup");
    tabs.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        tabs.querySelectorAll("button").forEach(function (x) {
          x.classList.remove("active");
        });
        b.classList.add("active");
        var isSignup = b.dataset.pane === "signup";
        if (loginPane) loginPane.hidden = isSignup;
        if (signupPane) signupPane.hidden = !isSignup;
      });
    });
  }

  // Demo forms never submit — this site is for presentation only.
  document.querySelectorAll("form[data-demo]").forEach(function (f) {
    f.addEventListener("submit", function (e) {
      e.preventDefault();
    });
  });
})();
