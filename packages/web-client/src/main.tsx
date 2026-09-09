import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LanguageProvider } from "./i18n/LanguageContext";
import "./index.css";

try {
  const stored = localStorage.getItem("finanfa-theme");
  if (stored) document.documentElement.dataset.theme = stored;
} catch {
  // best-effort — falls back to the default dark palette.
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </React.StrictMode>,
);
