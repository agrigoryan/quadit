// The editor's schema: BlockNote's own blocks, plus four inline things
// the server knows by other names (see editor/convert.ts): a mention, a task
// chip, a decision chip and a link to a page.

import { BlockNoteSchema, defaultInlineContentSpecs } from "@blocknote/core";
import { UniqueID } from "@blocknote/core/extensions";
import { createReactInlineContentSpec } from "@blocknote/react";
import { newId } from "@/lib/ids";
import { DecisionChip, MentionChip, PageChip, TaskChip } from "@/docs/editor/chips";

// New blocks get ids like every other row of the product (UUIDv7, made in the
// browser). BlockNote has no option for this; its id extension reads its
// defaults when an editor is made, so the default is replaced here, once.
const idConfig = UniqueID.config as { addOptions?: (this: unknown) => object };
const defaults = idConfig.addOptions;
idConfig.addOptions = function addOptions() {
  return { ...defaults?.call(this), generateID: newId };
};

const mention = createReactInlineContentSpec(
  { type: "mention", propSchema: { handle: { default: "" } }, content: "none" },
  { render: (p) => <MentionChip handle={p.inlineContent.props.handle} /> },
);

const taskChip = createReactInlineContentSpec(
  { type: "taskChip", propSchema: { key: { default: "" } }, content: "none" },
  { render: (p) => <TaskChip taskKey={p.inlineContent.props.key} editable={p.editor.isEditable} /> },
);

const decisionChip = createReactInlineContentSpec(
  { type: "decisionChip", propSchema: { key: { default: "" } }, content: "none" },
  { render: (p) => <DecisionChip decisionRef={p.inlineContent.props.key} editable={p.editor.isEditable} /> },
);

const pageLink = createReactInlineContentSpec(
  { type: "pageLink", propSchema: { doc: { default: "" } }, content: "none" },
  { render: (p) => <PageChip docId={p.inlineContent.props.doc} editable={p.editor.isEditable} /> },
);

export const schema = BlockNoteSchema.create({
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention, taskChip, decisionChip, pageLink },
});
