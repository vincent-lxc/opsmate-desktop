import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// react-router 8.3: BrowserRouter is exported from the package root (DOM bundle).
// The `react-router/dom` subpath is typed for RouterProvider / RSC helpers, not BrowserRouter.
import { BrowserRouter } from "react-router";
import { App } from "./app/App";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("root element missing");
}

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
