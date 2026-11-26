<script setup lang="ts">
// "Datum by Argusvane" at the foot of the sidebar: the docs pages have a sidebar, and VitePress shows its footer only on
// pages without one, so the credit lives here. The mark and the wordmark are the marketing site's (src/argusvane.ts).
import {
  ARGUSVANE_SIGNAL,
  ARGUSVANE_URL,
  MARK_EYE,
  MARK_OUTLINE,
  MARK_STEM,
  MARK_STROKE,
  MARK_VIEWBOX,
  WORDMARK_PATH,
  WORDMARK_VIEWBOX
} from "../../../src/argusvane";
</script>

<template>
  <p class="argusvane-credit">
    <span>Datum by</span>
    <a class="argusvane-credit__link" :href="ARGUSVANE_URL">
      <svg class="argusvane-credit__mark" :viewBox="MARK_VIEWBOX" width="10" height="16" aria-hidden="true">
        <path :d="MARK_OUTLINE" fill="none" stroke="currentColor" :stroke-width="MARK_STROKE" stroke-linejoin="miter" />
        <circle :cx="MARK_EYE.cx" :cy="MARK_EYE.cy" :r="MARK_EYE.r" :fill="ARGUSVANE_SIGNAL" />
        <line v-bind="MARK_STEM" stroke="currentColor" :stroke-width="MARK_STROKE" />
      </svg>
      <svg class="argusvane-credit__word" :viewBox="WORDMARK_VIEWBOX" width="93" height="10" role="img" aria-label="Argusvane">
        <path :d="WORDMARK_PATH" fill="currentColor" />
      </svg>
    </a>
  </p>
</template>
