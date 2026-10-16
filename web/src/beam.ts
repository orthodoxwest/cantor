// The header's light-or-dark switch: the page follows the system until the reader chooses,
// and remembers the choice. The script in each page's head applies it before the page is drawn.
const dark = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => (document.documentElement.dataset.theme ?? (dark.matches ? "dark" : "light")) === "dark";

export function themeSwitch(): void {
  const button = document.getElementById("theme");
  if (!button) return;
  const label = () => {
    const to = isDark() ? "Light" : "Dark";
    button.setAttribute("aria-label", `${to} pages`);
    button.title = `${to} pages`;
  };
  label();
  dark.addEventListener("change", label);
  button.addEventListener("click", () => {
    const theme = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("theme", theme);
    } catch {
      // Without storage the choice lasts this page.
    }
    label();
  });
}

// The header's sign-in link, for a visitor the Worker does not know. A signed-in visitor sees
// the library's private chants and the booklets' pointings; signing in returns to this page.
export async function offerSignIn(): Promise<void> {
  // Unknown is a 401 from the Worker, or Access sending the request off to its login page.
  const res = await fetch("/api/me", { redirect: "manual" }).catch(() => null);
  if (!res || (res.status !== 401 && res.type !== "opaqueredirect")) return;
  const beam = document.querySelector(".beam-in");
  if (!beam || beam.querySelector(".signin")) return;
  const a = document.createElement("a");
  a.className = "signin";
  a.textContent = "Sign in";
  const here = () => (a.href = `/signin?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
  here();
  // The page's address changes as it is used (a piece opened, a psalm pointed); the link follows.
  for (const event of ["pointerdown", "focus", "contextmenu", "click"]) a.addEventListener(event, here);
  beam.classList.add("offers-signin");
  beam.append(a);
}
