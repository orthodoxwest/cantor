// The header's sign-in link, for a visitor the Worker does not know. A signed-in visitor sees
// the library's private chants and the booklets' pointings; signing in returns to this page.
export async function offerSignIn(): Promise<void> {
  const res = await fetch("/api/me").catch(() => null);
  if (res?.status !== 401) return;
  const beam = document.querySelector(".beam-in");
  if (!beam || beam.querySelector(".signin")) return;
  const a = document.createElement("a");
  a.className = "signin";
  a.textContent = "Sign in";
  a.href = `/signin?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
  a.addEventListener("click", () => {
    a.href = `/signin?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
  });
  beam.append(a);
}
