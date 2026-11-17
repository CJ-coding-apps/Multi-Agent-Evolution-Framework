/**
 * `@maf/viewer` — one self-contained, network-free HTML view of a signed MAF run record, or of an
 * evolver session report (WP-3.18).
 */
export { escapeHtml, renderRunView, renderSessionView } from './render.js';
export type { RenderRunOptions, RenderSessionOptions } from './render.js';
export { viewRun, viewSession, defaultViewerIo } from './viewer.js';
export type { ViewerIo, RunViewOptions, SessionViewOptions, ViewOutput } from './viewer.js';
export type {
  Banner, CallView, NodeView, PolicyView, RunView, SessionRoundView, SessionView, SurfaceView,
} from './model.js';
