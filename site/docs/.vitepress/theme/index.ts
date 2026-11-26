import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { h } from "vue";
import ArgusvaneCredit from "./ArgusvaneCredit.vue";
import LiveExample from "./examples/LiveExample.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  // The default layout, with "Datum by Argusvane" under the sidebar's links.
  Layout: () => h(DefaultTheme.Layout, null, { "sidebar-nav-after": () => h(ArgusvaneCredit) }),
  enhanceApp({ app }) {
    // A docs page places a live example by name: <LiveExample name="form" />.
    app.component("LiveExample", LiveExample);
  }
} satisfies Theme;
