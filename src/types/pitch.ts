export type SegmentPitch = {
  start: number;
  end: number;
  text: string;
  label: string | null;
  peak_pos: number | null;
  pitch_range: number | null;
  slope: number | null;
};

export type WordPitch = {
  start: number;
  end: number;
  text: string;
  label: string | null;
  peak_pos: number | null;
  pitch_range: number | null;
  slope: number | null;
};

export type PitchAnalysis = {
  extractor?: string | null;
  time_step: number;
  sample_rate: number;
  f0_hz: Array<number | null>;
  f0_rel: Array<number | null>;
  segments?: SegmentPitch[] | null;
  words?: WordPitch[] | null;
};
