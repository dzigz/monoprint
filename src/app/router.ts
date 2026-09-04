import { useCallback, useEffect, useState } from "react";

export type Route =
  | { name: "home" }
  | { name: "working"; generationId: string }
  | { name: "deck"; deckId: string; slideId?: string };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "runs" && parts[1]) return { name: "working", generationId: parts[1] };
  if (parts[0] === "decks" && parts[1]) return { name: "deck", deckId: parts[1], slideId: parts[2] };
  return { name: "home" };
}

export function routePath(route: Route) {
  switch (route.name) {
    case "home": return "/";
    case "working": return `/runs/${route.generationId}`;
    case "deck": return route.slideId ? `/decks/${route.deckId}/${route.slideId}` : `/decks/${route.deckId}`;
  }
}

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = useCallback((next: Route, { replace = false }: { replace?: boolean } = {}) => {
    const url = routePath(next);
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
    setRoute(next);
  }, []);
  return { route, navigate };
}
