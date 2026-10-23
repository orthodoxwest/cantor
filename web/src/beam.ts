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
  beam.append(a);
}
