// Every user-facing label about Drainage-Area Ratio Transfer water, in one
// place. People will not know the term, so each label leads with a plain
// phrase and carries the glossary term in parentheses. The term is always
// written in full (docs/architecture/glossary.md), never abbreviated.

export const DRAINAGE_AREA_RATIO_TRANSFER_TERM = 'Drainage-Area Ratio Transfer';

/** Sidebar checkbox that shows or hides the borrowed-flow water. */
export const DRAINAGE_AREA_RATIO_TRANSFER_TOGGLE_LABEL = `Show side creeks with borrowed flow (${DRAINAGE_AREA_RATIO_TRANSFER_TERM})`;

/** Sidebar legend row for the lighter blue water. */
export const DRAINAGE_AREA_RATIO_TRANSFER_LEGEND_LABEL = `Side creek, borrowed flow (${DRAINAGE_AREA_RATIO_TRANSFER_TERM})`;

/** Heading and body of the explanation inside the collapsed Dataset details. */
export const DRAINAGE_AREA_RATIO_TRANSFER_EXPLANATION_HEADING = `Side creeks with borrowed flow (${DRAINAGE_AREA_RATIO_TRANSFER_TERM})`;
export const DRAINAGE_AREA_RATIO_TRANSFER_EXPLANATION =
  'Some small side creeks have no flow value in this model. For those, we borrow the flow of the nearest modeled creek that drains the same area and scale it by how much land drains to each spot (the USGS drainage-area ratio method). These are shown in lighter blue and can be hidden with the checkbox above.';

/** Dev tools section title and subtitle. */
export const DRAINAGE_AREA_RATIO_TRANSFER_DEV_TOOLS_TITLE = 'Side creeks with borrowed flow';
export const DRAINAGE_AREA_RATIO_TRANSFER_DEV_TOOLS_SUBTITLE = DRAINAGE_AREA_RATIO_TRANSFER_TERM;

/** Appended to a Creek Segment reading when the segment is flagged. */
export const DRAINAGE_AREA_RATIO_TRANSFER_READING_NOTE = `borrowed flow (${DRAINAGE_AREA_RATIO_TRANSFER_TERM})`;

/** Dev tools empty states, in plain words. */
export const DRAINAGE_AREA_RATIO_TRANSFER_NO_FLAGS_YET =
  'The pipeline has not marked any side creeks yet; rerun the pipeline.';
export const DRAINAGE_AREA_RATIO_TRANSFER_NONE_IN_EXTENT = 'No side creeks with borrowed flow in this extent.';
export const DRAINAGE_AREA_RATIO_TRANSFER_NONE_IN_JALAMA_EXTENT =
  'No side creeks with borrowed flow in this extent; switch to ?modeledExtent=dangermond-preserve.';
/** Button under the empty state that reloads the page on the extent that has them. */
export const DRAINAGE_AREA_RATIO_TRANSFER_SWITCH_EXTENT_LABEL = 'Switch to Dangermond Preserve extent';
