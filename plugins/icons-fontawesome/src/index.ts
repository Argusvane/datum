import {
  faAlignLeft,
  faBarsStaggered,
  faBox,
  faCalendarDay,
  faCalendarDays,
  faCircleDot,
  faDisplay,
  faCircleExclamation,
  faCircleInfo,
  faClipboardCheck,
  faClock,
  faClone,
  faCode,
  faCube,
  faDollarSign,
  faEllipsis,
  faEnvelope,
  faEye,
  faEyeSlash,
  faFileArrowDown,
  faFileArrowUp,
  faFileCirclePlus,
  faFileLines,
  faFilePdf,
  faFolder,
  faFolderOpen,
  faFont,
  faGlobe,
  faGripVertical,
  faHandPointer,
  faHashtag,
  faHeading,
  faIcons,
  faIdCard,
  faImage,
  faLanguage,
  faLayerGroup,
  faLeftRight,
  faLink,
  faListCheck,
  faListOl,
  faLock,
  faMinus,
  faObjectGroup,
  faPalette,
  faParagraph,
  faPhone,
  faPrint,
  faRectangleList,
  faRotateLeft,
  faRotateRight,
  faShapes,
  faSquareRootVariable,
  faSignature,
  faGear,
  faSliders,
  faSquareCaretDown,
  faSquareCaretRight,
  faSquareCheck,
  faStar,
  faTable,
  faTableCellsLarge,
  faTableColumns,
  faTableList,
  faToggleOn,
  faTriangleExclamation,
  faWindowMaximize,
  faWindowMinimize,
  type IconDefinition
} from "@fortawesome/free-solid-svg-icons";
import { svgIconSet, type DatumIconName, type IconSet, type SvgGlyph } from "@argusvane/datum-engine";

/**
 * Font Awesome Free as an icon set for the engine's chrome: one solid glyph per
 * name in the engine's vocabulary, drawn from `@fortawesome/free-solid-svg-icons` (icons
 * CC BY 4.0, code MIT) as inline SVG path data filled with `currentColor` — no webfont, so it
 * works inside every shadow root. The `datum-icons-fontawesome.js` bundle registers this
 * set as the default; a host that wants it registers it the same way:
 *
 *     import { setDefaultIconSet } from "@argusvane/datum-engine";
 *     import { FONT_AWESOME_ICONS } from "@argusvane/datum-icons-fontawesome";
 *     setDefaultIconSet(FONT_AWESOME_ICONS);
 *
 * This file is the whole adapter — what "bring your own icons" amounts to for any library
 * that ships path data: a glyph per name, handed to `svgIconSet`.
 */

export const FONT_AWESOME_ICONS_ID = "font-awesome";

/** One Font Awesome definition as an engine glyph: its viewBox and its path(s) on `currentColor`. */
export function fontAwesomeGlyph(def: IconDefinition): SvgGlyph {
  const [width, height, , , path] = def.icon;
  const body = (Array.isArray(path) ? path : [path]).map((d) => `<path fill="currentColor" d="${d}"/>`).join("");
  return { viewBox: `0 0 ${width} ${height}`, body };
}

/** The Font Awesome glyph behind every name the engine's chrome draws. */
export const FONT_AWESOME_GLYPHS: Readonly<Record<DatumIconName, IconDefinition>> = {
  // --- chrome ---
  undo: faRotateLeft,
  redo: faRotateRight,
  "preview-width": faLeftRight,
  binding: faPalette,
  "show-hidden": faEye,
  "hide-hidden": faEyeSlash,
  "drag-handle": faGripVertical,
  "form-panel": faFileLines,
  "chrome-panel": faWindowMaximize,
  "components-panel": faShapes,
  "properties-panel": faSliders,
  "outline-panel": faBarsStaggered,
  "variables-panel": faSquareRootVariable,
  "view-panel": faDisplay,
  "settings-panel": faGear,
  "translations-panel": faLanguage,
  "tests-panel": faListCheck,
  "fields-panel": faTableList,
  "document-menu": faEllipsis,
  "new-form": faFileCirclePlus,
  "open-form": faFolderOpen,
  "download-form": faFileArrowDown,
  validate: faClipboardCheck,
  print: faPrint,
  pdf: faFilePdf,
  // --- palette: fields ---
  "field-text": faFont,
  "field-textarea": faAlignLeft,
  "field-email": faEnvelope,
  "field-password": faLock,
  "field-phone": faPhone,
  "field-url": faGlobe,
  "field-number": faHashtag,
  "field-currency": faDollarSign,
  "field-slider": faSliders,
  "field-rating": faStar,
  "field-checkbox": faSquareCheck,
  "field-checkboxes": faListCheck,
  "field-toggle": faToggleOn,
  "field-radio": faCircleDot,
  "field-select": faSquareCaretDown,
  "field-date": faCalendarDays,
  "field-time": faClock,
  "field-datetime": faCalendarDay,
  "field-file": faFileArrowUp,
  "field-signature": faSignature,
  // --- palette: actions ---
  "action-button": faHandPointer,
  // --- palette: containers ---
  "container-form": faRectangleList,
  "container-fieldset": faObjectGroup,
  "container-section": faLayerGroup,
  "container-box": faBox,
  "container-tabs": faFolder,
  "container-grid": faTableCellsLarge,
  "container-row": faTableColumns,
  "container-column": faTableList,
  "container-table": faTable,
  "container-repeater": faClone,
  "container-step": faListOl,
  // --- palette: static content ---
  "content-heading": faHeading,
  "content-paragraph": faParagraph,
  "content-html": faCode,
  "content-divider": faMinus,
  "content-image": faImage,
  "content-header": faWindowMaximize,
  "content-footer": faWindowMinimize,
  "content-link": faLink,
  "content-card": faIdCard,
  "content-details": faSquareCaretRight,
  "content-notice": faCircleInfo,
  "content-alert": faTriangleExclamation,
  "content-icon": faIcons,
  "content-error-summary": faCircleExclamation,
  component: faCube
};

export const FONT_AWESOME_ICONS: IconSet = svgIconSet(
  FONT_AWESOME_ICONS_ID,
  Object.fromEntries(
    Object.entries(FONT_AWESOME_GLYPHS).map(([name, def]) => [name, fontAwesomeGlyph(def)])
  ) as Record<DatumIconName, SvgGlyph>
);
