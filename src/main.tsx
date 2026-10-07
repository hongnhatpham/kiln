import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { loadApi } from "./api.ts";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/app.css";

const root = createRoot(document.getElementById("root")!);

loadApi().then((bridge) => {
  root.render(
    <StrictMode>
      {bridge ? (
        <App api={bridge.api} mock={bridge.mock} />
      ) : (
        <main className="unavailable">
          <h1>Kiln runs as a desktop app</h1>
          <p>Open Kiln from its application window to prepare 3D scans.</p>
        </main>
      )}
    </StrictMode>,
  );
});
