// The state of an open compare view: how the options are laid out, which
// option has the focus, which file of each option is showing, the shared zoom, whether pictures keep hard
// pixel edges, the videos on stage, and the pick waiting for its confirmation.

import { useCallback, useRef, useState } from "react";
import { isVideo } from "@/data/files";
import type { Decision, DecisionOption } from "@/types/core";
import type { Steps } from "@/ui/carousel";
import { isSmallArt, type OptionFile, type OptionFiles, type Viewer } from "@/decisions/data";
import { useSharedZoom, type Zoom } from "@/decisions/use-zoom";

/**
 * How a desktop shows the options: side by side, or the focused one alone
 * as large as the stage allows. A phone always shows one per screen.
 */
export type Layout = "side-by-side" | "one";

export interface CompareProps {
  decision: Decision;
  options: DecisionOption[];
  /** Pictures and videos of each option, by option id; a before/after pair is one entry. */
  media: OptionFiles;
  viewer: Viewer;
  /** Where to open: the position of an option and of one of its files, and the layout. */
  start: { option: number; file: number; layout: Layout };
  onClose: () => void;
  onPick: (optionId: string) => void;
  onPickWithChanges: (option: DecisionOption) => void;
  onNone: () => void;
}

export interface Compare extends CompareProps {
  /** Changes only when the person switches it. */
  layout: Layout;
  setLayout: (layout: Layout) => void;
  focus: number;
  focused: DecisionOption | undefined;
  /** Moves the focus, staying inside the options. Drops a pick that waits for confirmation. */
  focusOn: (index: number) => void;
  filesOf: (option: DecisionOption) => OptionFile[];
  fileIndexOf: (option: DecisionOption) => number;
  fileOf: (option: DecisionOption) => OptionFile | undefined;
  /** The carousel through one option's files: it goes round. */
  fileSteps: (option: DecisionOption) => Steps;
  /**
   * The walk one at a time: every option's files in order, one option after
   * the other (an option with none is one stop). Coming back into an option
   * starts on its last file. It stops at the ends, as numbered choices do.
   */
  walk: Steps;
  zoom: Zoom;
  /** Screen pixels per picture pixel of the focused file when it fits its pane. */
  fit: number;
  setFit: (fit: number) => void;
  /** What the "Pixel-perfect" switch shows: the person's choice, else whether the focused picture is sprite art. */
  pixelated: boolean;
  /** The person's own choice; it then holds for every picture. */
  setPixelated: (on: boolean) => void;
  /** Whether a picture of this size is drawn with hard edges: small art is, until the person says otherwise. */
  sharp: (width: number | undefined, height: number | undefined) => boolean;
  /** The pane the zoom is measured on says whether its picture is small art (its size may be known only once loaded). */
  setSmallArt: (small: boolean) => void;
  /** The option a number key chose, until Enter confirms or Escape cancels. */
  pending: DecisionOption | undefined;
  setPending: (optionId: string | null) => void;
  playing: boolean;
  setPlaying: (playing: boolean) => void;
  setVideo: (optionId: string, el: HTMLVideoElement | null) => void;
  videos: () => HTMLVideoElement[];
  hasVideo: (options: DecisionOption[]) => boolean;
}

export function useCompare(props: CompareProps): Compare {
  const { options, media, viewer } = props;
  const [layout, setLayout] = useState(props.start.layout);
  const [focus, setFocus] = useState(props.start.option);
  const [shown, setShown] = useState<Record<string, number>>(() => {
    const first = options[props.start.option];
    return first ? { [first.id]: props.start.file } : {};
  });
  const [fit, setFit] = useState(1);
  // Sprite art opens sharp: smoothing a 32-pixel picture up to the screen shows nothing of it.
  const [smallArt, setSmallArt] = useState(() => {
    const first = options[props.start.option];
    const file = first ? media[first.id]?.[props.start.file] : undefined;
    return isSmallArt(file?.width, file?.height);
  });
  const [pixelChoice, setPixelChoice] = useState<boolean | null>(null);
  const [pendingId, setPending] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const zoom = useSharedZoom(1 / fit);
  const stage = useRef(new Map<string, HTMLVideoElement>());

  const filesOf = (option: DecisionOption) => media[option.id] ?? [];
  const fileIndexOf = (option: DecisionOption) =>
    Math.min(shown[option.id] ?? 0, Math.max(0, filesOf(option).length - 1));
  const fileOf = (option: DecisionOption) => filesOf(option)[fileIndexOf(option)];

  const setVideo = useCallback((optionId: string, el: HTMLVideoElement | null) => {
    if (el) stage.current.set(optionId, el);
    else stage.current.delete(optionId);
  }, []);
  const videos = useCallback(() => [...stage.current.values()], []);

  function walkOf(): Steps {
    const stops = options.map((o) => Math.max(1, filesOf(o).length));
    const before = (at: number) => stops.slice(0, at).reduce((sum, n) => sum + n, 0);
    const focused = options[focus];
    return {
      index: before(focus) + (focused ? fileIndexOf(focused) : 0),
      total: before(options.length),
      wrap: false,
      onShow: (index) => {
        let option = 0;
        while (option < stops.length - 1 && index >= before(option + 1)) option++;
        const to = options[option];
        if (!to) return;
        setFocus(option);
        setShown((s) => ({ ...s, [to.id]: index - before(option) }));
        setPending(null);
      },
    };
  }

  return {
    ...props,
    layout,
    setLayout,
    focus,
    focused: options[focus],
    focusOn: (index) => {
      setFocus(Math.min(options.length - 1, Math.max(0, index)));
      setPending(null);
    },
    filesOf,
    fileIndexOf,
    fileOf,
    fileSteps: (option) => ({
      index: fileIndexOf(option),
      total: filesOf(option).length,
      wrap: true,
      onShow: (index) => setShown((s) => ({ ...s, [option.id]: index })),
    }),
    walk: walkOf(),
    zoom,
    fit,
    setFit,
    pixelated: pixelChoice ?? smallArt,
    setPixelated: setPixelChoice,
    sharp: (width, height) => pixelChoice ?? isSmallArt(width, height),
    setSmallArt,
    pending: viewer.canAnswer ? options.find((o) => o.id === pendingId) : undefined,
    setPending,
    playing,
    setPlaying,
    setVideo,
    videos,
    hasVideo: (list) => list.some((o) => isVideo(fileOf(o))),
  };
}

/** The words under an option's name on stage: why it is recommended, or its description. */
export function paneNote(c: Compare, option: DecisionOption): string {
  const recommended = c.decision.recommended_option_id === option.id;
  return (recommended && c.decision.recommendation) || option.description || "";
}
