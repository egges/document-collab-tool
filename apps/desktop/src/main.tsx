import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource-variable/literata";
import "@fontsource-variable/literata/wght-italic.css";
import "@fontsource-variable/nunito";
import "@fontsource-variable/nunito/wght-italic.css";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";
import "@pagemesh/editor/style.css";
import "./app.css";
import { App } from "./App.tsx";
import { pageFont } from "./pageFont.ts";
import { setUpPreferences } from "./preferences.ts";
import { setUpTheme } from "./theme.ts";
import { setUpWindowChrome } from "./windowChrome.ts";
import { setUpZoom } from "./zoom.ts";

setUpTheme();
pageFont.load();
setUpPreferences();
setUpWindowChrome();
setUpZoom();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
