import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import "./styles/themes.css";
const application = new URLSearchParams(window.location.search).get(
  "application",
);
const Root = application
  ? lazy(() => import("./applications/ApplicationWindow"))
  : lazy(() => import("./App"));
createRoot(document.getElementById("root")!).render(
  <Suspense fallback={<p>正在加载…</p>}>
    <Root />
  </Suspense>,
);
