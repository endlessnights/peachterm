import type { Modifier } from '@dnd-kit/core';

/** Keep dragged tabs on the tab strip (avoids pulling in @dnd-kit/modifiers). */
export const restrictToHorizontalAxisModifier: Modifier = ({ transform }) => ({
  ...transform,
  y: 0,
});
