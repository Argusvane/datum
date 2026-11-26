import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import LiveExample from "./examples/LiveExample.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    // A docs page places a live example by name: <LiveExample name="form" />.
    app.component("LiveExample", LiveExample);
  }
} satisfies Theme;
