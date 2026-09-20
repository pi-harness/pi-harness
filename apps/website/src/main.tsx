import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router.js";
import "./styles.css";

const root = document.getElementById("root");
if (!(root instanceof HTMLElement)) throw new Error("Pi Harness website is missing #root");

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
