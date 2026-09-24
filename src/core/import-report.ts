export interface ImportReport {
  importBatch: string;
  seriesEntityId: string;
  seriesVersionId: string;
  blobCount: number;
  reusedBlobs: number;
  documentCount: number;
  frameCount: number;
  trackCount: number;
  unconvertible: { lineNo: number; line: string; diagnostic: string }[];
  warnings: string[];
}
