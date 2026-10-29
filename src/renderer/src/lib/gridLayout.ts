// The grid layout functions live in plugin-ui so plugins (Navide Browser's
// tiled Spaces) page and size their grids exactly like the pane stage.
export {
  gridPageCount,
  gridPageOf,
  gridPageSlice,
  gridPresetDims,
  parseGridPreset,
} from '@navide/plugin-ui/shared'
export type { GridPreset } from '@navide/plugin-ui/shared'
