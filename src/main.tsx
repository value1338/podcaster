import "@fontsource-variable/inter";
import "./styles/tokens.css";
import "./styles/base.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { App } from "./App";

// VITE_BASE "/podcast/" → basename "/podcast"
const basename = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";
const router = createBrowserRouter([{ path: "*", element: <App /> }], { basename });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
