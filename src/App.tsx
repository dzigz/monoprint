import { useEffect, useState } from "react";
import { api } from "./app/api";
import { useRoute } from "./app/router";
import { DeckPage } from "./pages/DeckPage";
import { HomePage } from "./pages/HomePage";
import { WorkingPage } from "./pages/WorkingPage";
import type { AppConfig } from "./shared/types";

export default function App() {
  const { route, navigate } = useRoute();
  const [config, setConfig] = useState<AppConfig>();

  useEffect(() => {
    void api.config().then(setConfig).catch(() => setConfig(undefined));
  }, []);

  switch (route.name) {
    case "working":
      return <WorkingPage key={route.generationId} generationId={route.generationId} navigate={navigate} />;
    case "deck":
      return <DeckPage key={route.deckId} deckId={route.deckId} slideId={route.slideId} config={config} navigate={navigate} />;
    default:
      return <HomePage config={config} navigate={navigate} />;
  }
}
