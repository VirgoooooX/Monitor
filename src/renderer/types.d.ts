// Type augmentations for the renderer bundle.
//
// Vite supports importing files as raw strings via the `?raw` query.
// We rely on this for inlining the colored brand SVGs from
// `@lobehub/icons-static-svg`. Without this declaration, TS would
// complain about untyped module specifiers.

declare module '*.svg?raw' {
  const content: string;
  export default content;
}
