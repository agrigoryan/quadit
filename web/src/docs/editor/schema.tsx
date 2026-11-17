// The editor's schema: BlockNote's own blocks, plus four inline things
// the server knows by other names (see editor/convert.ts): a mention, a task
// chip, a decision chip and a link to a page; a code style that other
// styles and a link may wrap; and the marker of the comment threads on
// words of the page.

import {
  BlockNoteSchema,
  createStyleSpec,
  createStyleSpecFromTipTapMark,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
} from "@blocknote/core";
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
  {
    render: (p) => (
      <MentionChip
        handle={p.inlineContent.props.handle}
        editable={p.editor.isEditable}
        focusEditor={() => p.editor.prosemirrorView.focus()}
      />
    ),
  },
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

// BlockNote's code mark excludes every other formatting mark, the link
// among them, but Markdown keeps "**bold `code` bold**" and "[`code`](url)"
// (internal/md). The same mark, with its look, backtick input rule and
// shortcut, excluding nothing, holds them.
const code = createStyleSpecFromTipTapMark(
  defaultStyleSpecs.code.implementation.mark.extend({ excludes: "" }),
  "boolean",
);

// The words a comment thread is on carry its id in this style, "comment":
// "ID ID" for the threads on them (internal/md, comments.go). The server
// puts it on and keeps it there; nobody formats with it, so it has no
// button or key. Text typed right after the words is not theirs (not
// inclusive), and a copy pasted elsewhere does not take the threads with it:
// the style is never read from pasted HTML. Text cut and pasted into
// another block gets its threads back from the server, which finds the
// words there. Each span names the threads (data-value) for the highlight
// of the open ones (editor/highlights.tsx).
const commentStyle = createStyleSpec(
  { type: "comment", propSchema: "string" },
  {
    render: () => {
      const dom = document.createElement("span");
      return { dom, contentDOM: dom };
    },
  },
);
const comment = {
  ...commentStyle,
  implementation: {
    ...commentStyle.implementation,
    mark: commentStyle.implementation.mark.extend({ inclusive: false, parseHTML: () => [] }),
  },
};

export const schema = BlockNoteSchema.create({
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention, taskChip, decisionChip, pageLink },
  styleSpecs: { ...defaultStyleSpecs, code, comment },
});
