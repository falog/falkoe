import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { getStoredUiLanguage, initI18n } from "./i18n";

initI18n(getStoredUiLanguage() ?? undefined);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
