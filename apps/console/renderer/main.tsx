import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./src/app.jsx";
import "./src/styles.css";

createRoot(document.getElementById("root")!).render(<App />);
