"use strict";
// The header's light-or-dark switch: the page follows the system until the reader chooses,
// and remembers the choice. The script in each page's head applies it before the page is drawn;
// this file stands apart from the bundle (public/, deferred) so the switch works before the page's
// larger script has loaded.
{
  const root = document.documentElement;
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const isDark = () => (root.dataset.theme ?? (dark.matches ? "dark" : "light")) === "dark";

  function stored() {
    try {
      return localStorage.getItem("theme");
    } catch {
      return null;
    }
  }

  const button = document.getElementById("theme");

  function label() {
    if (!button) return;
    const to = isDark() ? "Light" : "Dark";
    button.setAttribute("aria-label", `${to} pages`);
    button.title = `${to} pages`;
  }

  /** Takes up a choice made in another tab, or while this page waited in the back-forward cache. */
  function follow() {
    const theme = stored();
    if (theme === "light" || theme === "dark") root.dataset.theme = theme;
    label();
  }

  label();
  dark.addEventListener("change", label);
  addEventListener("storage", (e) => e.key === "theme" && follow());
  addEventListener("pageshow", (e) => e.persisted && follow());
  button?.addEventListener("click", () => {
    const theme = isDark() ? "light" : "dark";
    root.dataset.theme = theme;
    try {
      localStorage.setItem("theme", theme);
    } catch {
      // Without storage the choice lasts this page.
    }
    label();
  });
}
