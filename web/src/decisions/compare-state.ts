// The state of an open compare view: which option has the focus, which file
// of each option is showing, the shared zoom, the videos on stage, and the
// pick waiting for its confirmation.

import { useCallback, useRef, useState } from "react";
import { isVideo } from "@/lib/files";
import type { Decision, DecisionOption, FileRow } from "@/lib/types";
import type { OptionFiles, Viewer } from "@/decisions/data";
import { useSharedZoom, type Zoom } from "@/decisions/use-zoom";

export interface CompareProps {
  decision: Decision;
  options: DecisionOption[];
  /** Pictures and videos of each option, by option id. */
  media: OptionFiles;
  viewer: Viewer;
  /** Where to open: the position of an option and of one of its files. */
  start: { option: number; file: number };
  onClose: () => void;
  onPick: (optionId: string) => void;
  onPickWithChanges: (option: DecisionOption) => void;
  onNone: () => void;
}

export interface Compare extends CompareProps {
  focus: number;
  focused: DecisionOption | undefined;
  /** Moves the focus, staying inside the options. Drops a pick that waits for confirmation. */
  focusOn: (index: number) => void;
  filesOf: (option: DecisionOption) => FileRow[];
  fileIndexOf: (option: DecisionOption) => number;
  fileOf: (option: DecisionOption) => FileRow | undefined;
  stepFile: (option: DecisionOption, delta: number) => void;
  zoom: Zoom;
  /** Screen pixels per picture pixel of the focused file when it fits its pane. */
  fit: number;
  setFit: (fit: number) => void;
  pixelated: boolean;
  setPixelated: (on: boolean) => void;
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
  const [focus, setFocus] = useState(props.start.option);
  const [shown, setShown] = useState<Record<string, number>>(() => {
    const first = options[props.start.option];
    return first ? { [first.id]: props.start.file } : {};
  });
  const [fit, setFit] = useState(1);
  const [pixelated, setPixelated] = useState(false);
  const [pendingId, setPending] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const zoom = useSharedZoom(1 / fit);
  const stage = useRef(new Map<string, HTMLVideoElement>());

  const filesOf = (option: DecisionOption) => media[option.id] ?? [];
  const fileIndexOf = (option: DecisionOption) => Math.min(shown[option.id] ?? 0, Math.max(0, filesOf(option).length - 1));
  const fileOf = (option: DecisionOption) => filesOf(option)[fileIndexOf(option)];

  const setVideo = useCallback((optionId: string, el: HTMLVideoElement | null) => {
    if (el) stage.current.set(optionId, el);
    else stage.current.delete(optionId);
  }, []);
  const videos = useCallback(() => [...stage.current.values()], []);

  return {
    ...props,
    focus,
    focused: options[focus],
    focusOn: (index) => {
      setFocus(Math.min(options.length - 1, Math.max(0, index)));
      setPending(null);
    },
    filesOf,
    fileIndexOf,
    fileOf,
    stepFile: (option, delta) => {
      const next = fileIndexOf(option) + delta;
      if (next >= 0 && next < filesOf(option).length) setShown((s) => ({ ...s, [option.id]: next }));
    },
    zoom,
    fit,
    setFit,
    pixelated,
    setPixelated,
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
