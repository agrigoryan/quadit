// The two steps to an agent that answers what is written in Quadit, as
// Connect agents and the first run's tools step show them above the cards:
// connected is not listening, and a person reads "Connected" as "it will
// answer me" unless told. The line to write is the skill's own words
// (integrations/skills/quadit/SKILL.md, Listening). Styled by tools.css.

import { make } from "@/pages/dom";

/** What the person writes in a tool's chat to have it listen. */
export const LISTEN_LINE = "listen to Quadit";

/** The steps, in a box a page can add a line of its own to. */
export function listenSteps(): HTMLElement {
  const box = make("section", "", "how");
  box.setAttribute("aria-labelledby", "how-title");
  const title = make("p", "To have an agent answer you in Quadit", "how-title");
  title.id = "how-title";
  const steps = make("ol", "", "how-steps");
  // Each step's words in one span: the step's number is the other column (tools.css).
  const step = (...words: (Node | string)[]) => {
    const item = make("li");
    const said = make("span");
    said.append(...words);
    item.append(said);
    return item;
  };
  const first = step(
    make("b", "Connect it here."),
    " It can then reach Quadit, and works there when you ask it in a chat.",
  );
  const second = step(
    make("b", "In its chat, in your project’s folder, write "),
    make("code", LISTEN_LINE),
    make("b", "."),
    " This is the way we recommend: it then answers what you assign to it or ask it in Quadit as it comes in. It asks which project when it cannot tell.",
  );
  steps.append(first, second);
  box.append(
    title,
    steps,
    make(
      "p",
      "Without listening it still works: it sees what waits for it whenever you ask it in a chat, for example “check Quadit”.",
      "how-else",
    ),
  );
  return box;
}
