import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App as AntApp } from "antd";
import "./styles/terminal.css";
import "./styles/module-table.css";
import "./i18n";
import { AppProvider } from "./providers/AppProvider";
import { App } from "./App";
import { initNativeAuth } from "./desktop/native-auth";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

// Desktop: subscribe to secret-free session events + poll status (no JWT in WebView).
void initNativeAuth().catch(() => {
  // Browser / missing Tauri event API — ignore.
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <AppProvider>
          <AntApp>
            <App />
          </AntApp>
        </AppProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </StrictMode>,
);