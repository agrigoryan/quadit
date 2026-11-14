// The editor's schema: BlockNote's own blocks, plus three inline things
// the server knows by other names (see editor/convert.ts): a mention, a task
// chip and a link to a page.

import { BlockNoteSchema, defaultInlineContentSpecs } from "@blocknote/core";
import { createReactInlineContentSpec } from "@blocknote/react";
import { MentionChip, PageChip, TaskChip } from "@/docs/editor/chips";

const mention = createReactInlineContentSpec(
  { type: "mention", propSchema: { handle: { default: "" } }, content: "none" },
  { render: (p) => <MentionChip handle={p.inlineContent.props.handle} /> },
);

const taskChip = createReactInlineContentSpec(
  { type: "taskChip", propSchema: { key: { default: "" } }, content: "none" },
  { render: (p) => <TaskChip taskKey={p.inlineContent.props.key} /> },
);

const pageLink = createReactInlineContentSpec(
  { type: "pageLink", propSchema: { doc: { default: "" } }, content: "none" },
  { render: (p) => <PageChip docId={p.inlineContent.props.doc} /> },
);

export const schema = BlockNoteSchema.create({
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention, taskChip, pageLink },
});

export type DocEditor = typeof schema.BlockNoteEditor;
