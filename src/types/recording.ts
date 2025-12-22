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

export type Transcript = {
  segments: Segment[];
};
