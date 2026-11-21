import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@document-collab-tool/editor/style.css";
import "./app.css";
import { App } from "./App.tsx";
import { setUpWindowChrome } from "./windowChrome.ts";

setUpWindowChrome();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
