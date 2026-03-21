export type VectorCollection = {
  name: string;
  pointsCount: number;
  status: string;
};

export type VectorStatsResponse = {
  enabled: boolean;
  collections: VectorCollection[];
};

export type VectorPoint2D = {
  id: string;
  x: number;
  y: number;
  payload: Record<string, unknown>;
};

export type VectorReduceResponse = {
  collection: string;
  points: VectorPoint2D[];
  reductionMethod: string;
  totalPointsInCollection: number;
};

export type ScrollPoint = {
  id: string;
  payload: Record<string, unknown>;
};

export type VectorScrollResponse = {
  points: ScrollPoint[];
  nextOffset: string | null;
};
