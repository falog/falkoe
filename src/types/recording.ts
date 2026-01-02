export type Recording = {
  path: string;
  fileName: string;
  timestamp: string;
  dateLabel: string;
};

export type Segment = {
  start: number;
  end: number;
  text: string;
};

export type TokenTimestamp = {
  start: number;
  end: number;
  text: string;
  dtw?: number;
};

export type WordTimestamp = {
  start: number;
  end: number;
  text: string;
};

export type Transcript = {
  segments: Segment[];
  tokens?: TokenTimestamp[];
  words?: WordTimestamp[];
};
